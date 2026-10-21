import type { AgentResult } from "@di/agent";
import { CommandError } from "di-tui";
import type {
  RpcAgentResult,
  RpcCommandDescriptor,
  RpcReadyMessage,
  RunnerCommandResult,
  RunnerPort,
  RunnerPortHandlers,
} from "di-tui";
import { CLI_VERSION } from "../cli/cli-info.ts";
import type { CliHost } from "../cli/cli-host.ts";
import type { CommandContext } from "../core/commands/command-context.ts";
import { StringCommandOutput } from "../core/commands/command-context.ts";
import type { EventConsumer } from "../core/events/event-bus.ts";
import { ModelSelectionError } from "../core/model-selection.ts";
import { computeSkillActivation } from "../core/skills/skill-activation.ts";
import { LexicalSkillMatcher } from "../core/skills/skill-matcher.ts";
import type { Skill } from "../core/skills/skill.ts";
import { errorMessage } from "../modes/common.ts";
import { eventPayload, isAbortError, resultPayload, zeroUsage } from "../modes/wire.ts";

/**
 * LocalAgentRunnerAdapter：把生产 CLI 的同进程 CoreRunner（CliHost 组合根，P7a
 * createSessionRunner 桥接 AgentSession）适配到 di-tui 的 {@link RunnerPort}，
 * 供 `di-tui.runInteractive(port)` 直接驱动现有 TUI 组件树（零子进程、零 RPC）。
 *
 * 这是 Core `AgentEvent` / `AgentResult`（@di/agent camelCase）与 protocol wire
 * `RpcAgentEvent` / `RpcAgentResult`（tui/src/rpc/protocol.ts snake_case）之间
 * 的**唯一转换点**——转换函数由 {@link ../../modes/wire.ts} 共享给 `--mode rpc`
 * 路径，保证同进程与子进程 RPC 两种后端产出的 wire 载荷字节级等价（同一事件序、
 * 同一载荷形状；`interrupted` 事件省略、软停经 result.stop_reason 上报等）。
 *
 * 生命周期契约（architecture.md §RunnerPort）：
 * - subscribe → connect（ready 握手恰好一次）→ prompt（一次事件流 + result）；
 * - interrupt = 硬取消（绑定到 prompt 的 AbortController，映射 stop_reason "cancelled"，
 *   绝不连到 CoreRunner.requestSoftStop）；
 * - 回合失败消化为 result.stop_reason "error"（消息而非崩溃），会话级错误走 onError；
 * - stop 幂等，优雅 teardown（中止在途回合，使同进程退出不被挂起）。
 */
export class LocalAgentRunnerAdapter implements RunnerPort {
  private readonly host: CliHost;
  /** 固定（pinned）skill 集；setSkills / /skill 命令读写，与 REPL/RPC 会话语义一致。 */
  private readonly pinned: Skill[] = [];
  private handlers: RunnerPortHandlers | null = null;
  /** 在途回合的取消源（interrupt → abort → cancelled）。 */
  private turnCts: AbortController | null = null;
  private connected = false;
  private stopped = false;

  constructor(host: CliHost) {
    if (host == null) throw new TypeError("LocalAgentRunnerAdapter: host is required");
    this.host = host;
  }

  /* ------------------------- RunnerPort：生命周期 ------------------------- */

  subscribe(handlers: RunnerPortHandlers): () => void {
    this.handlers = handlers;
    return () => {
      if (this.handlers === handlers) this.handlers = null;
    };
  }

  /**
   * 握手：刷新模型目录（尽力而为）→ 写会话首行（尽力而为）→ 从组合根生成等价
   * ReadyMessage（version/model/effort?/skills/models）→ 调用 onReady 后 resolve。
   * 未订阅 handlers 视为契约违反（connect 只应在 onReady 已执行一次后 resolve）。
   */
  async connect(): Promise<void> {
    if (this.connected) throw new Error("RunnerPort 已连接，请勿重复 connect()");
    if (this.stopped) throw new Error("RunnerPort 已停止");
    if (this.handlers === null) {
      throw new Error("RunnerPort 未订阅 handlers（connect 前须调用 subscribe）");
    }
    this.connected = true;

    // 刷新模型目录（ready 携带目录快照供 /model 补全；失败只告警，不阻塞握手）。
    for (const error of await this.host.models.refresh()) this.warn(error);

    // 会话开始写首行 session_meta（尽力而为；--no-session 时 host.sessionStore 缺失）。
    try {
      this.host.sessionStore?.startSession();
    } catch (error) {
      this.warn(`⚠ 会话日志初始化失败: ${errorMessage(error)}`);
    }

    const meta: RpcReadyMessage = {
      type: "ready",
      version: CLI_VERSION,
      model: this.host.runner.currentModel,
      ...(this.host.reasoningEffort !== undefined && this.host.reasoningEffort !== null
        ? { effort: this.host.reasoningEffort }
        : {}),
      skills: this.host.skills.map((s) => ({ name: s.name, description: s.description })),
      models: this.host.models.list().map((m) => ({ id: `${m.provider}/${m.id}`, name: m.name })),
    };
    this.handlers.onReady(meta);
  }

  /** 运行一回合。返回的 promise 在 onResult(result) 已调用后 resolve 为同一 result。 */
  prompt(message: string): Promise<RpcAgentResult> {
    if (this.stopped) return Promise.reject(new Error("RunnerPort 已停止"));
    if (this.turnCts !== null) {
      return Promise.reject(new Error("上一回合尚未终结（busy），请等待 result 或先 interrupt"));
    }
    const cts = new AbortController();
    this.turnCts = cts;
    const promise = this.runTurn(message, cts);
    // 回合终结（成功或消化后）即视为槽位空闲；interrupt/shutdown 在等待期间仍可到达。
    void promise.finally(() => {
      if (this.turnCts === cts) this.turnCts = null;
    });
    return promise;
  }

  /** 硬取消当前回合 → 对应 result.stop_reason "cancelled"。 */
  interrupt(): void {
    this.turnCts?.abort();
  }

  /** 清空屏幕 + 对话记忆。 */
  clearHistory(): void {
    this.host.runner.resetHistory();
  }

  /** 切换模型（异步；成功无应答，失败走 onError，busy/invalid_model 同 RPC 语义）。 */
  setModel(model: string): void {
    if (this.turnCts !== null) {
      this.handlers?.onError("请等待当前回合结束后切换模型。", "busy");
      return;
    }
    this.host.models.select(model).then(
      () => {
        /* 成功：TUI 状态栏经下一次 command_ran 快照更新 */
      },
      (error: unknown) => {
        if (error instanceof ModelSelectionError && error.code === "busy") {
          this.handlers?.onError(error.message, "busy");
        } else {
          this.handlers?.onError(errorMessage(error), "invalid_model");
        }
      },
    );
  }

  /** 替换固定 skill 集（只接受宿主已发现的 skill；未知名静默忽略）。 */
  setSkills(names: string[]): void {
    const wanted = new Set(names);
    this.pinned.length = 0;
    for (const skill of this.host.skills) if (wanted.has(skill.name)) this.pinned.push(skill);
    this.host.runner.setActiveSkills([...this.pinned]);
  }

  /** 列出后端斜杠命令注册表（/ 补全用）。 */
  listCommands(): Promise<RpcCommandDescriptor[]> {
    return Promise.resolve(
      this.host.commands
        .list()
        .map((c) => ({
          name: c.name,
          description: c.description,
          ...(c.argumentHint !== undefined ? { argument_hint: c.argumentHint } : {}),
        })),
    );
  }

  /**
   * 运行一个后端斜杠命令（同步应答）。回合型命令（/skill <名> <参数>、用户命令）
   * → 抛 {@link CommandError}（code=turn_not_supported，带 turnMessage）；
   * 未知命令 / busy → CommandError。应答携带执行后的模型/强度快照（/model 用）。
   */
  async runCommand(name: string, args = ""): Promise<RunnerCommandResult> {
    const cmd = this.host.commands.tryGet(name);
    if (cmd === undefined) {
      throw new CommandError("unknown_command", `未知命令: /${name}`);
    }
    // 回合进行中 model/thinking 拒绝切换（同 RPC command busy 前置检查）。
    if (this.turnCts !== null && (name === "model" || name === "thinking")) {
      throw new CommandError("busy", "请等待当前回合结束后切换模型。");
    }

    const buffer = new StringCommandOutput();
    const context: CommandContext = {
      registry: this.host.commands,
      host: this.host.runner,
      skills: this.host.skills,
      output: buffer,
      pinned: this.pinned,
      useAnsi: false,
      models: this.host.models,
    };

    let commandResult;
    try {
      commandResult = await cmd.handler(args, context);
    } catch (error) {
      if (error instanceof ModelSelectionError && error.code === "busy") {
        throw new CommandError("busy", error.message);
      }
      throw error;
    }

    if (commandResult.turnMessage !== undefined && commandResult.turnMessage.length > 0) {
      throw new CommandError(
        "turn_not_supported",
        `命令 /${name} 是回合型命令，TUI 应改用 prompt 执行（turn_message 已附指令全文）`,
        commandResult.turnMessage,
      );
    }

    return {
      lines: bufferLines(buffer),
      exit: commandResult.exit,
      model: this.host.runner.currentModel,
      ...(this.host.reasoningEffort !== undefined && this.host.reasoningEffort !== null
        ? { effort: this.host.reasoningEffort }
        : {}),
      ...(name === "model"
        ? { models: this.host.models.list().map((m) => ({ id: `${m.provider}/${m.id}`, name: m.name })) }
        : {}),
    };
  }

  /** 心跳，无应答。 */
  ping(): void {
    /* no-op heartbeat */
  }

  /** 优雅 teardown（幂等）：中止在途回合，使同进程退出不被挂起。 */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.turnCts?.abort();
  }

  /* ------------------------- 回合驱动（与 --mode rpc 同构） ------------------------- */

  private async runTurn(message: string, cts: AbortController): Promise<RpcAgentResult> {
    const consumer = this.host.bus.subscribe();
    const forwardTask = this.forwardEvents(consumer);
    const startedAt = Date.now();

    // 自动匹配：按本条消息与 skill 描述的语义相关度加载未固定的 skill（共享计算，headless 同款）。
    const activation = computeSkillActivation(message, this.host.skills, this.pinned, new LexicalSkillMatcher());
    this.host.runner.setActiveSkills(activation.active);

    let result: AgentResult;
    try {
      result = await this.host.runner.runTurn(message, cts.signal);
    } catch (error) {
      this.host.bus.release(consumer);
      await forwardTask;
      this.drain(consumer);
      if (isAbortError(error)) {
        // 回合被 interrupt 取消：合成 cancelled result（AgentStopReason 无此值，宿主层映射）。
        const cancelled: RpcAgentResult = { answer: "", stop_reason: "cancelled", iterations: 0, usage: zeroUsage() };
        this.emitResult(cancelled);
        return cancelled;
      }
      // 回合失败是消息不是崩溃：result.stop_reason "error" 并带 failure。
      const errResult: RpcAgentResult = {
        answer: "",
        stop_reason: "error",
        iterations: 0,
        usage: zeroUsage(),
        failure: { code: "model_error", message: errorMessage(error) },
      };
      this.emitResult(errResult);
      // 失败回合也落盘（尽力而为）：否则异常回合在会话文件里"查无此证"。
      try {
        this.host.sessionStore?.appendFailure(message, errorMessage(error), startedAt);
      } catch (logError) {
        this.warn(`⚠ 会话日志写入失败: ${errorMessage(logError)}`);
      }
      return errResult;
    }

    this.host.bus.release(consumer);
    await forwardTask;
    this.drain(consumer);
    try {
      this.host.sessionStore?.appendTurn(result, startedAt);
    } catch (logError) {
      this.warn(`⚠ 会话日志写入失败: ${errorMessage(logError)}`);
    }
    const payload = resultPayload(result);
    this.emitResult(payload);
    return payload;
  }

  /** 实时转发事件（每个事件都按序投递；interrupted 省略：TUI codec 不接受该 kind）。 */
  private async forwardEvents(consumer: EventConsumer): Promise<void> {
    for await (const event of consumer) {
      const payload = eventPayload(event);
      if (payload === undefined) continue;
      this.handlers?.onEvent(payload);
    }
  }

  /** 尽力排空 forwarder 未消费的事件（对齐 rpc-mode 的 Drain）。 */
  private drain(consumer: EventConsumer): void {
    let event = consumer.tryRead();
    while (event !== null) {
      const payload = eventPayload(event);
      if (payload !== undefined) this.handlers?.onEvent(payload);
      event = consumer.tryRead();
    }
  }

  /** 完成时调用一次 onResult（prompt promise 以同一 result resolve；调用方不可再更新 UI 状态）。 */
  private emitResult(result: RpcAgentResult): void {
    this.handlers?.onResult(result);
  }

  /** 会话级诊断（等价于子进程路径写到 stderr 的文本，经 onStderr 送达 TUI）。 */
  private warn(text: string): void {
    this.handlers?.onStderr?.(`${text}\n`);
  }
}

/** 命令输出缓冲 → 非空行数组（无 \r；命令应答不携带 ANSI）。 */
function bufferLines(buffer: StringCommandOutput): string[] {
  return buffer
    .toString()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.replace(/\r$/, ""));
}
