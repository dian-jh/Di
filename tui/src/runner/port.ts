/**
 * RunnerPort：TUI（未来 di-tui）与后端 runner 之间的 wire-shape 契约。
 *
 * 类型别名直接对应 `tui/src/rpc/protocol.ts` 中真实导出的 wire 类型
 * （AgentEvent / AgentResult / CommandDescriptor / ModelInfo / ReadyMessage），
 * 不另造 schema。di-tui 只依赖本文件与 protocol.ts，绝不导入 @di/agent /
 * @di/coding-agent；实现方由宿主注入（RPC 子进程路径用 {@link RpcClientPort}，
 * 生产 CLI 用 coding-agent 的 LocalAgentRunnerAdapter）。
 *
 * 生命周期契约（architecture.md §RunnerPort 生命周期与接线顺序）：
 * - subscribe(handlers) 在 connect() 之前注册 handler，connect() 只在 onReady(meta)
 *   已执行一次后 resolve；
 * - prompt 建立本回合完成等待后再启动回合，完成时 onResult(result) 恰一次，
 *   promise 以同一 result resolve（调用方不可再更新 UI 状态）；
 * - interrupt 是硬取消（TUI 首按 Ctrl+C 行为），映射为 wire stop_reason "cancelled"；
 * - stop 幂等，优雅 teardown。
 */

import type {
  AgentEvent,
  AgentResult,
  CommandDescriptor,
  ModelInfo,
  ReadyMessage,
} from "../rpc/protocol.ts";

/** protocol.ts 的 wire-shape 别名：di-tui 公开的 RunnerPort 载荷即这些类型。 */
export type RpcAgentEvent = AgentEvent;
export type RpcAgentResult = AgentResult;
export type RpcCommandDescriptor = CommandDescriptor;
export type RpcReadyMessage = ReadyMessage;

/** 后端 → TUI 的异步回调。onReady/onEvent/onResult/onError 在订阅后由 connect/prompt 驱动。 */
export interface RunnerPortHandlers {
  /** connect 握手：携带当前模型/强度/skills/模型目录快照（恰好一次）。 */
  onReady(meta: RpcReadyMessage): void;
  /** 回合内流式事件（text/reasoning/tool deltas、工具生命周期、turn_completed、run_failed）。 */
  onEvent(event: RpcAgentEvent): void;
  /** 回合终结（每个 prompt 恰好一次）。 */
  onResult(result: RpcAgentResult): void;
  /** 会话级不可恢复错误（message 为可读文本，code 为协议错误码）。 */
  onError(message: string, code: string): void;
  /** 后端退出（子进程路径用；同进程 adapter 通常不触发）。 */
  onExit?(code: number | null, signal: NodeJS.Signals | null): void;
  /** 原始 stderr 输出（子进程路径转控制台诊断；同进程 adapter 通常不触发）。 */
  onStderr?(chunk: string): void;
  /** 无法解析的协议行（子进程路径用；同进程 adapter 不产生线协议，不触发）。 */
  onMalformed?(line: string, error: Error): void;
}

/** `command run` 的统一应答（docs/tui-rpc.md §2.5 command_ran 形状）。 */
export interface RunnerCommandResult {
  readonly lines: string[];
  readonly exit: boolean;
  /** 命令执行后的模型标签（/model 切换后 TUI 据此更新状态栏）。 */
  readonly model?: string;
  /** 命令执行后的推理强度（null = 已清除）。 */
  readonly effort?: string | null;
  /** /model 命令附带的模型目录快照（参数补全刷新用）。 */
  readonly models?: ModelInfo[];
}

/**
 * 后端 runner 的统一操作面（di-tui 公开、宿主提供实现）。覆盖现有
 * `tui/src/rpc/client.ts` 的可见操作；callback 载荷沿用 protocol.ts 的
 * ReadyMessage / AgentEvent / AgentResult / CommandDescriptor。
 */
export interface RunnerPort {
  /** 注册 handler（返回注销函数）。connect 前必须调用一次。 */
  subscribe(handlers: RunnerPortHandlers): () => void;
  /** 连接并等待 ready 握手；resolve 之前 onReady(meta) 必须已执行一次。 */
  connect(): Promise<void>;
  /** 运行一回合。返回的 promise 在对应 result 到达时 resolve 为同一 result。 */
  prompt(message: string): Promise<RpcAgentResult>;
  /** 硬取消当前回合 → result.stop_reason "cancelled"（保持 TUI 首按 Ctrl+C 行为）。 */
  interrupt(): void;
  /** 清空屏幕 + 对话记忆。 */
  clearHistory(): void;
  /** 切换模型（TUI 当前经 /model 命令，此方法供协议/测试直接调用）。 */
  setModel(model: string): void;
  /** 替换固定 skill 集（TUI 当前经 /skill 命令，此方法供协议/测试直接调用）。 */
  setSkills(names: string[]): void;
  /** 列出后端斜杠命令注册表（/ 补全用）。 */
  listCommands(): Promise<RpcCommandDescriptor[]>;
  /**
   * 运行一个后端斜杠命令（同步应答）。回合型命令（/skill <名> <参数>、用户命令）
   * → reject {@link CommandError}（code=turn_not_supported，带 turnMessage）。
   */
  runCommand(name: string, args?: string): Promise<RunnerCommandResult>;
  /** 心跳，后端无应答。 */
  ping(): void;
  /** 优雅关闭（幂等；TUI 退出 finally 中调用）。 */
  stop(): Promise<void>;
}
