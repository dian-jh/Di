/**
 * 子进程 RPC 客户端：spawn 后端（`--mode rpc`），走 NDJSON over stdin/stdout 协议。
 *
 * - 启动器可注入：`launcher: { bin, args }` 完整描述如何 spawn（如 `process.execPath` +
 *   编译后 TS 入口参数，绕开 Windows npm `.cmd` shim）；缺省回退到 `bin` + `args`
 *   （二进制解析顺序：env DI_BIN → PATH 上的 `di` → `~/.di/bin/di.exe`（win32））。
 * - 等待 `ready` 握手后才允许发请求。
 * - 请求带单调递增 id；无逐请求回执，`prompt` 的"回执"是事件流 + 一个 `result`（终态恰好一次）。
 * - 回合进行中（busy）拒绝新 prompt，避免 result 串台。
 * - 优雅退出：发 `shutdown` 等进程退出，超时后 SIGKILL。
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { encodeMessage, LineBuffer, parseMessage, ProtocolError } from "./codec.ts";
import type {
  AgentEvent,
  AgentResult,
  CommandDescriptor,
  CommandParams,
  ModelInfo,
  ReadyMessage,
  RequestMessage,
  RequestMethod,
  RequestParams,
} from "./protocol.ts";
import { makeRequest } from "./protocol.ts";

/** `command` 请求的统一应答：list / run / error 三种（docs/tui-rpc.md §2.5）。 */
export type CommandOutcome =
  | { kind: "listed"; commands: CommandDescriptor[] }
  | { kind: "ran"; name: string; lines: string[]; exit: boolean; model?: string; effort?: string | null; models?: ModelInfo[] }
  | { kind: "error"; code: string; message: string; turnMessage?: string };

/** `command` 请求的拒绝载体：message 保留 `code: message` 可读文本；回合型命令带 turnMessage。 */
export class CommandError extends Error {
  readonly code: string;
  readonly turnMessage?: string;

  constructor(code: string, message: string, turnMessage?: string) {
    super(`${code}: ${message}`);
    this.name = "CommandError";
    this.code = code;
    this.turnMessage = turnMessage;
  }
}

/** 可注入的 spawn 工厂（测试替换为假子进程用）。 */
export type SpawnFn = (bin: string, args: string[]) => ChildProcess;

/**
 * TS 后端启动器：完整描述如何 spawn 后端进程（bin + args 的启动单元）。
 * Windows 上 npm `.cmd`/`.bat` shim 不能直接当原生可执行文件 spawn，
 * 开发期 launcher 可为 `process.execPath` + 编译后 TS 入口参数
 * （例如 `node packages/coding-agent/dist/cli/main.js --mode rpc`）。
 */
export interface Launcher {
  /** 可执行文件路径（须为原生可执行）。 */
  bin: string;
  /** 启动参数（例如编译后 TS 入口 + `--mode rpc`）。 */
  args: string[];
}

export type RpcClientState = "idle" | "connecting" | "ready" | "closed";

export interface RpcClientOptions {
  /** 后端启动器（完整 spawn 描述）。提供时优先于 bin/args。 */
  launcher?: Launcher;
  /** di 可执行文件路径（launcher 未提供时的后备）。 */
  bin?: string;
  /** 附加参数，默认 ["--mode", "rpc"]（launcher 未提供时生效）。 */
  args?: string[];
  /** 注入 spawn 工厂（默认 Node 原生 spawn）。 */
  spawnFn?: SpawnFn;
  /** 进程环境变量（默认 process.env）。 */
  env?: NodeJS.ProcessEnv;
  /** 等待 `ready` 的超时（默认 5000ms）。 */
  readyTimeoutMs?: number;
  /** 发 `shutdown` 后等待退出的超时（默认 2000ms）。 */
  stopTimeoutMs?: number;

  onReady?: (meta: ReadyMessage) => void;
  onEvent?: (event: AgentEvent) => void;
  onResult?: (result: AgentResult) => void;
  onError?: (message: string, code: string) => void;
  /** 子进程退出（任意原因）。 */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** stderr 原始输出（转发给控制台做诊断）。 */
  onStderr?: (chunk: string) => void;
  /** 收到无法解析的协议行。 */
  onMalformed?: (line: string, error: Error) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 解析 `di` 可执行文件路径。
 * 顺序：`DI_BIN` 环境变量 → PATH 上的 `di`（win32 含 .exe/.cmd/.bat）→ `~/.di/bin/di.exe`。
 * 找不到返回 undefined。
 */
export function resolveDiBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.DI_BIN) {
    return env.DI_BIN;
  }
  const isWin = process.platform === "win32";
  const exts = isWin ? ["", ".exe", ".cmd", ".bat"] : [""];
  const pathVar = env.PATH ?? "";
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `di${ext}`);
      if (isFile(candidate)) return candidate;
    }
  }
  const home = env.USERPROFILE ?? env.HOME;
  if (home) {
    const candidate = path.join(home, ".di", "bin", isWin ? "di.exe" : "di");
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

export class RpcClient {
  /** 生效的后端启动器（注入的 launcher，或由 bin/args 合成）。 */
  readonly launcher: Launcher;
  readonly binary: string;
  private readonly args: string[];
  private readonly spawnFn: SpawnFn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly readyTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly options: RpcClientOptions;

  private child: ChildProcess | null = null;
  private nextId = 1;
  private stateValue: RpcClientState = "idle";
  private lineBuffer = new LineBuffer();

  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private ready = false;

  private pendingTurn: { resolve: (r: AgentResult) => void; reject: (e: Error) => void } | null = null;
  private pendingCommand: { resolve: (o: CommandOutcome) => void; reject: (e: Error) => void } | null = null;

  private exited = false;
  private exitedResolve: (() => void) | null = null;
  private exitedPromise: Promise<void>;

  constructor(options: RpcClientOptions) {
    this.options = options;
    const launcher = options.launcher ?? { bin: options.bin ?? "", args: options.args ?? ["--mode", "rpc"] };
    if (!launcher.bin) {
      throw new Error("缺少后端启动器：请提供 launcher（bin + args）或 bin");
    }
    this.launcher = launcher;
    this.binary = launcher.bin;
    this.args = launcher.args;
    this.spawnFn =
      options.spawnFn ??
      ((bin, args) => spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: this.env }));
    this.env = options.env ?? process.env;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 5000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 2000;
    this.exitedPromise = new Promise((resolve) => {
      this.exitedResolve = resolve;
    });
  }

  get state(): RpcClientState {
    return this.stateValue;
  }

  /**
   * spawn 后端进程并等待 `ready` 握手。
   * 若子进程在握手前退出或超时，reject 并清理子进程。
   */
  async connect(): Promise<void> {
    if (this.child) {
      throw new Error("客户端已连接，请勿重复 connect()");
    }
    this.stateValue = "connecting";
    const child = this.spawnFn(this.launcher.bin, this.launcher.args);
    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdoutData(chunk));
    child.stderr?.on("data", (chunk: string) => {
      this.options.onStderr?.(chunk);
      // 默认转发到控制台做诊断（stderr 不参与协议）。
      process.stderr.write(chunk);
    });
    child.on("exit", (code, signal) => this.onChildExit(code, signal));
    child.on("error", (err) => this.onChildError(err));

    await this.waitForReady();
  }

  private waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimer = setTimeout(() => {
        reject(new Error(`等待后端 ready 超时（${this.readyTimeoutMs}ms）；di 可能未支持 --mode rpc。`));
        this.killChild();
      }, this.readyTimeoutMs);
    }).finally(() => {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
    });
  }

  /* ------------------------- 请求方法 ------------------------- */

  /**
   * 运行一回合。返回的 promise 在对应 `result` 到达时 resolve。
   * 协议无 result↔request 关联（docs/tui-rpc.md §1 请求串行、§2.3 result 归属当前回合），
   * 故回合进行中（busy）拒绝新 prompt，而不是覆盖在途回合——保证每个回合终态恰好一次、不被串台。
   */
  prompt(message: string): Promise<AgentResult> {
    if (!this.ready) {
      return Promise.reject(new Error("RPC 未就绪（尚未收到 ready）"));
    }
    if (this.pendingTurn) {
      return Promise.reject(new Error("上一回合尚未终结（busy），请等待 result 或先 interrupt"));
    }
    this.sendRequest("prompt", { message });
    return new Promise<AgentResult>((resolve, reject) => {
      this.pendingTurn = { resolve, reject };
    });
  }

  /** 取消当前回合 → 对应 result.stop_reason: "cancelled"。 */
  interrupt(): void {
    if (this.ready) this.sendRequest("interrupt", {});
  }

  setModel(model: string): void {
    if (this.ready) this.sendRequest("set_model", { model });
  }

  setSkills(names: string[]): void {
    if (this.ready) this.sendRequest("set_skills", { names });
  }

  clearHistory(): void {
    if (this.ready) this.sendRequest("clear_history", {});
  }

  /** 列出后端斜杠命令注册表（内置 + 用户命令；协议 §3 command/list）。 */
  listCommands(): Promise<CommandDescriptor[]> {
    return this.sendCommand({ list: true }).then((outcome) => {
      if (outcome.kind === "listed") return outcome.commands;
      throw new Error(outcome.kind === "error" ? `${outcome.code}: ${outcome.message}` : "意外的命令应答");
    });
  }

  /**
 * 运行一个后端斜杠命令（同步应答）。应答携带切换后的模型/强度快照（/model 用，状态栏据此更新）。
 * 回合型命令（/skill <名> <参数>、用户命令）→ 抛 {@link CommandError}（code=turn_not_supported，带 turnMessage）。
 */
  runCommand(name: string, args = ""): Promise<{ lines: string[]; exit: boolean; model?: string; effort?: string | null; models?: ModelInfo[] }> {
    return this.sendCommand({ name, args }).then((outcome) => {
      if (outcome.kind === "ran") {
        return { lines: outcome.lines, exit: outcome.exit, model: outcome.model, effort: outcome.effort,
          ...(outcome.models === undefined ? {} : { models: outcome.models }) };
      }
      if (outcome.kind === "error") {
        throw new CommandError(outcome.code, outcome.message, outcome.turnMessage);
      }
      throw new Error("意外的命令应答");
    });
  }

  /**
   * 发一条 `command` 请求，等对应应答。请求串行、应答按请求序同步返回（协议 §1/§2.5），
   * 与 prompt 的事件流不交错，故单槽 pendingCommand 足够。
   */
  private sendCommand(params: CommandParams): Promise<CommandOutcome> {
    if (!this.ready) {
      return Promise.reject(new Error("RPC 未就绪（尚未收到 ready）"));
    }
    if (this.pendingCommand) {
      this.pendingCommand.reject(new Error("上一命令尚未应答，被新的 command 取代"));
    }
    this.sendRequest("command", params);
    return new Promise<CommandOutcome>((resolve, reject) => {
      this.pendingCommand = { resolve, reject };
    });
  }

  /** 心跳，后端无应答。 */
  ping(): void {
    if (this.ready) this.sendRequest("ping", {});
  }

  private sendRequest(method: RequestMethod, params: RequestParams): void {
    if (!this.child || !this.child.stdin?.writable) {
      throw new Error(`无法发送请求（后端未运行或 stdin 已关闭）: ${method}`);
    }
    const request: RequestMessage = makeRequest(this.nextId++, method, params);
    this.child.stdin.write(encodeMessage(request));
  }

  /**
   * 优雅关闭：发 `shutdown` 请求，等待进程退出；超时则 SIGKILL。
   * 可重复调用（幂等）；未 spawn 过子进程时直接置为 closed。
   */
  async stop(): Promise<void> {
    if (this.stateValue === "closed") return;
    const child = this.child;
    if (child && child.stdin?.writable && this.ready) {
      try {
        this.sendRequest("shutdown", {});
      } catch {
        /* 后端可能已经退出，忽略 */
      }
    }
    if (child && !this.exited) {
      const exited = await Promise.race([
        this.exitedPromise.then(() => true),
        delay(this.stopTimeoutMs).then(() => false),
      ]);
      if (!exited) {
        this.killChild("SIGKILL");
        await Promise.race([
          this.exitedPromise.then(() => true),
          delay(this.stopTimeoutMs).then(() => false),
        ]);
      }
    }
    this.stateValue = "closed";
  }

  /** 强制杀子进程（优先 SIGTERM，失败退 SIGKILL）。 */
  private killChild(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.child) return;
    try {
      this.child.kill(signal);
    } catch {
      /* 已经退出，忽略 */
    }
  }

  /* ------------------------- 子进程事件处理 ------------------------- */

  private onStdoutData(chunk: string): void {
    const lines = this.lineBuffer.push(chunk);
    for (const line of lines) {
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message;
    try {
      message = parseMessage(line);
    } catch (err) {
      const error = err instanceof ProtocolError ? err : new Error(String(err));
      this.options.onMalformed?.(line, error);
      return;
    }
    switch (message.type) {
      case "ready":
        this.ready = true;
        this.stateValue = "ready";
        this.options.onReady?.(message);
        this.readyResolve?.();
        this.readyResolve = null;
        break;
      case "event":
        this.options.onEvent?.(message.event);
        break;
      case "result":
        if (!this.pendingTurn) {
          // 终态恰好一次：无在途回合的 result 视为协议异常（如有缺陷后端重复 result），忽略并告警。
          process.stderr.write("[rpc] 收到无主 result，忽略（终态应恰好一次）\n");
          break;
        }
        this.options.onResult?.(message.result);
        this.pendingTurn.resolve(message.result);
        this.pendingTurn = null;
        break;
      case "error":
        this.options.onError?.(message.message, message.code);
        if (this.pendingTurn) {
          this.pendingTurn.reject(new Error(`${message.code}: ${message.message}`));
          this.pendingTurn = null;
        }
        if (this.pendingCommand) {
          this.pendingCommand.reject(new Error(`${message.code}: ${message.message}`));
          this.pendingCommand = null;
        }
        break;
      case "command_listed":
        this.pendingCommand?.resolve({ kind: "listed", commands: message.commands });
        this.pendingCommand = null;
        break;
      case "command_ran":
        this.pendingCommand?.resolve({
          kind: "ran",
          name: message.name,
          lines: message.lines,
          exit: message.exit,
          model: message.model,
          effort: message.effort,
          models: message.models,
        });
        this.pendingCommand = null;
        break;
      case "command_error":
        this.pendingCommand?.reject(new CommandError(message.code, message.message, message.turn_message));
        this.pendingCommand = null;
        break;
      default:
        // 向后兼容：未知 type 忽略并告警（不应发生）。
        process.stderr.write(`[rpc] 忽略未知消息类型\n`);
        break;
    }
  }

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exited = true;
    this.exitedResolve?.();
    const closing = this.stateValue === "connecting" ? "握手前" : "运行中";
    if (this.stateValue === "connecting") {
      const err = new Error(
        `后端进程在${closing}退出（exit=${code ?? "?"}${signal ? `, signal=${signal}` : ""}）；` +
          `后端可能未支持 --mode rpc，或启动器 ${this.binary} 指向了错误的二进制。`,
      );
      this.readyReject?.(err);
      this.readyReject = null;
    } else if (this.pendingTurn) {
      this.pendingTurn.reject(
        new Error(`后端进程退出，当前回合未终结（exit=${code ?? "?"}${signal ? `, signal=${signal}` : ""}）`),
      );
      this.pendingTurn = null;
    } else if (this.pendingCommand) {
      this.pendingCommand.reject(
        new Error(`后端进程退出，命令未获应答（exit=${code ?? "?"}${signal ? `, signal=${signal}` : ""}）`),
      );
      this.pendingCommand = null;
    }
    this.ready = false;
    this.stateValue = "closed";
    this.options.onExit?.(code, signal);
  }

  private onChildError(err: Error): void {
    if (this.stateValue === "connecting") {
      const wrapped = new Error(`无法启动后端进程 ${this.binary}: ${err.message}`);
      this.readyReject?.(wrapped);
      this.readyReject = null;
      this.options.onExit?.(null, null);
      this.stateValue = "closed";
      return;
    }
    if (this.pendingTurn) {
      this.pendingTurn.reject(err);
      this.pendingTurn = null;
    } else if (this.pendingCommand) {
      this.pendingCommand.reject(err);
      this.pendingCommand = null;
    }
  }
}
