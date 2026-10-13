/**
 * 子进程 RPC 客户端：spawn `di --mode rpc`，走 NDJSON over stdin/stdout 协议。
 *
 * - 二进制解析顺序：env DI_BIN → PATH 上的 `di` → `~/.di/bin/di.exe`（win32）。
 * - 等待 `ready` 握手后才允许发请求。
 * - 请求带单调递增 id；无逐请求回执，`prompt` 的"回执"是事件流 + 一个 `result`。
 * - 优雅退出：发 `shutdown` 等进程退出，超时后 SIGKILL。
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { encodeMessage, LineBuffer, parseMessage, ProtocolError } from "./codec.ts";
import type { AgentEvent, AgentResult, RequestMessage, RequestMethod, RequestParams } from "./protocol.ts";
import { makeRequest } from "./protocol.ts";

/** 可注入的 spawn 工厂（测试替换为假子进程用）。 */
export type SpawnFn = (bin: string, args: string[]) => ChildProcess;

export type RpcClientState = "idle" | "connecting" | "ready" | "closed";

export interface RpcClientOptions {
  /** di 可执行文件路径。 */
  bin: string;
  /** 附加参数，默认 ["--mode", "rpc"]。 */
  args?: string[];
  /** 注入 spawn 工厂（默认 Node 原生 spawn）。 */
  spawnFn?: SpawnFn;
  /** 进程环境变量（默认 process.env）。 */
  env?: NodeJS.ProcessEnv;
  /** 等待 `ready` 的超时（默认 5000ms）。 */
  readyTimeoutMs?: number;
  /** 发 `shutdown` 后等待退出的超时（默认 2000ms）。 */
  stopTimeoutMs?: number;

  onReady?: (version: string) => void;
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

  private exited = false;
  private exitedResolve: (() => void) | null = null;
  private exitedPromise: Promise<void>;

  constructor(options: RpcClientOptions) {
    this.options = options;
    this.binary = options.bin;
    this.args = options.args ?? ["--mode", "rpc"];
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
    const child = this.spawnFn(this.binary, this.args);
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

  /** 运行一回合。返回的 promise 在对应 `result` 到达时 resolve。 */
  prompt(message: string): Promise<AgentResult> {
    if (!this.ready) {
      return Promise.reject(new Error("RPC 未就绪（尚未收到 ready）"));
    }
    this.sendRequest("prompt", { message });
    if (this.pendingTurn) {
      this.pendingTurn.reject(new Error("上一回合尚未终结，被新的 prompt 取代"));
    }
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
        this.options.onReady?.(message.version);
        this.readyResolve?.();
        this.readyResolve = null;
        break;
      case "event":
        this.options.onEvent?.(message.event);
        break;
      case "result":
        this.options.onResult?.(message.result);
        if (this.pendingTurn) {
          this.pendingTurn.resolve(message.result);
          this.pendingTurn = null;
        }
        break;
      case "error":
        this.options.onError?.(message.message, message.code);
        if (this.pendingTurn) {
          this.pendingTurn.reject(new Error(`${message.code}: ${message.message}`));
          this.pendingTurn = null;
        }
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
          `di 可能未支持 --mode rpc，或 DI_BIN 指向了错误的二进制。`,
      );
      this.readyReject?.(err);
      this.readyReject = null;
    } else if (this.pendingTurn) {
      this.pendingTurn.reject(
        new Error(`后端进程退出，当前回合未终结（exit=${code ?? "?"}${signal ? `, signal=${signal}` : ""}）`),
      );
      this.pendingTurn = null;
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
    }
  }
}
