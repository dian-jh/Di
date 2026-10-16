/**
 * Di RPC 线协议类型定义。
 *
 * 与 docs/tui-rpc.md 逐字段对应——该文档是双端实现的唯一权威契约，
 * 任何字段增删都必须先改文档再改这里。事件载荷形状以
 * Core.AgentLoop.AgentLoopEvent 为准。
 */

/* ---------------------------------------------------------------------------
 * 方向：核心 → TUI（stdout）
 * ------------------------------------------------------------------------- */

export type CoreMessage =
  | ReadyMessage
  | EventMessage
  | ResultMessage
  | ErrorMessage
  | CommandListedMessage
  | CommandRanMessage
  | CommandErrorMessage;

/** 一个可见 skill 的展示元数据（/skill 补全用）。 */
export interface SkillInfo {
  name: string;
  description: string;
}

/** 一个可供 /model 切换的模型条目（参数补全用）。 */
export interface ModelInfo {
  id: string;
  name: string;
}

/**
 * `{"type":"ready","version":"0.1.0",...}` —— 组合根构建完成、可服务请求后发出，仅一次。
 * 携带当前模型 / 强度 / skills / 模型目录快照（docs/tui-rpc.md §2.1），供状态栏与命令补全。
 */
export interface ReadyMessage {
  type: "ready";
  version: string;
  /** 当前生效模型名（/model 可切换）。 */
  model?: string;
  /** 推理强度（off/low/high/max 等，启动时固定；缺省 = 未配置）。 */
  effort?: string | null;
  /** 可见 skills（/skill 补全）。 */
  skills?: SkillInfo[];
  /** 模型目录（/model 参数补全）。 */
  models?: ModelInfo[];
}

/** `{"type":"event","seq":<int>,"event":{...}}` —— seq 单调递增（回合内连续）。 */
export interface EventMessage {
  type: "event";
  seq: number;
  event: AgentEvent;
}

/** `{"type":"result","seq":<int>,"result":{...}}` —— 每个 prompt 请求恰好一个，为该回合的终结。 */
export interface ResultMessage {
  type: "result";
  seq: number;
  result: AgentResult;
}

/** `{"type":"error","code":string,"message":string}` —— 会话级不可恢复错误。 */
export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

/** 注册表里的一条命令（<c>command list</c> 应答）。<c>argument_hint</c> 可空省略。 */
export interface CommandDescriptor {
  name: string;
  description: string;
  argument_hint?: string;
}

/** `{"type":"command_listed","commands":[...]}` —— `command list` 的应答。 */
export interface CommandListedMessage {
  type: "command_listed";
  commands: CommandDescriptor[];
}

/** `{"type":"command_ran","name":...,"lines":[...],"exit":bool,...}` —— `command run` 的同步应答。 */
export interface CommandRanMessage {
  type: "command_ran";
  name: string;
  lines: string[];
  exit: boolean;
  /** 命令执行后的模型/强度快照（/model 切换后 TUI 据此更新状态栏）。 */
  model?: string;
  effort?: string | null;
  models?: ModelInfo[];
}

/** `{"type":"command_error","code":...,"message":...}` —— 命令级错误（不含在 `error` 会话级语义内）。 */
export interface CommandErrorMessage {
  type: "command_error";
  code: string;
  message: string;
  /** 回合型命令（turn_not_supported）附带的指令全文，TUI 据此改用自身 prompt 机制跑回合。 */
  turn_message?: string;
}

/* ---------------------------------------------------------------------------
 * AgentLoopEvent 的线格式（按 kind 区分载荷）
 * ------------------------------------------------------------------------- */

export type AgentEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallDeltaEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | TurnCompletedEvent
  | RunFailedEvent;

/** 全部事件 kind 的字符串联合。 */
export type EventKind = AgentEvent["kind"];

export interface TextDeltaEvent {
  kind: "text_delta";
  delta: string;
}

export interface ReasoningDeltaEvent {
  kind: "reasoning_delta";
  delta: string;
}

/** 工具参数流式增量：`arguments` 为迄今原始 JSON 串，可能未完成。 */
export interface ToolCallDeltaEvent {
  kind: "tool_call_delta";
  id: string;
  name: string;
  arguments: string;
}

export interface ToolStartedEvent {
  kind: "tool_started";
  call: ToolCall;
}

export interface ToolCompletedEvent {
  kind: "tool_completed";
  call: ToolCall;
  observation: string;
  is_error: boolean;
}

export interface TurnCompletedEvent {
  kind: "turn_completed";
  iteration: number;
  usage: TokenUsage;
  cost?: number;
  finish_reason: string;
}

export interface RunFailedEvent {
  kind: "run_failed";
  failure: RunFailure;
}

export interface ToolCall {
  id: string;
  name: string;
  /** 工具参数（原始 JSON 串）。 */
  arguments: string;
}

export interface RunFailure {
  code: string;
  message: string;
  status?: number;
  provider_retry_after?: number;
}

/** TokenUsage（snake_case，null 键省略）。 */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

export type StopReason = "answer" | "final_output_tool" | "max_iterations" | "error" | "cancelled";

export interface AgentResult {
  answer: string;
  stop_reason: StopReason;
  iterations: number;
  usage: TokenUsage;
  cost?: number;
  failure?: { code: string; message: string };
}

/* ---------------------------------------------------------------------------
 * 方向：TUI → 核心（stdin）
 * ------------------------------------------------------------------------- */

/** 每行一个请求，串行处理（按行序）。 */
export interface RequestMessage {
  type: "request";
  id: number;
  method: RequestMethod;
  params: RequestParams;
}

export type RequestMethod =
  | "prompt"
  | "interrupt"
  | "set_model"
  | "set_skills"
  | "clear_history"
  | "command"
  | "ping"
  | "shutdown";

export interface PromptParams {
  message: string;
}

export interface SetModelParams {
  model: string;
}

export interface SetSkillsParams {
  names: string[];
}

export type EmptyParams = Record<string, never>;

/** `command` 请求：`list?: true` 列出注册表；否则按 `name`（+ 可选 `args`）运行。 */
export interface CommandParams {
  list?: true;
  name?: string;
  args?: string;
}

export type RequestParams = PromptParams | SetModelParams | SetSkillsParams | CommandParams | EmptyParams;

/** 构造一个请求消息（id 由调用方保证单调递增）。 */
export function makeRequest(id: number, method: RequestMethod, params: RequestParams): RequestMessage {
  return { type: "request", id, method, params };
}
