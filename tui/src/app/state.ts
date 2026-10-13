/**
 * 回合状态机 + 视图模型。
 *
 * 状态机：`idle → running → (cancelling) → idle`。
 * 事件流（`applyEvent`）把后端事件映射为视图模型变更：
 * - text_delta / reasoning_delta → 追加到当前助手消息
 * - tool_call_delta / tool_started / tool_completed → 工具条目（按 id 去重合并）
 * - turn_completed → 状态行显示 iteration / cost 脚注
 * - run_failed → 错误横幅 + 记录 failure
 *
 * 回合终结以 `result` 为准（协议 §2.3：每个 prompt 恰好一个 result）。
 */

import type { AgentEvent, AgentResult, RunFailure, TokenUsage, ToolCall } from "../rpc/protocol.ts";

export type TurnState = "idle" | "running" | "cancelling";

export type ToolStatus = "pending" | "running" | "completed" | "failed";

export interface ToolCallEntry {
  id: string;
  name: string;
  /** 迄今原始 JSON 串（可能未完成）。 */
  arguments: string;
  status: ToolStatus;
  observation?: string;
}

export interface TurnView {
  id: number;
  userMessage: string;
  /** 累计助手文本。 */
  answer: string;
  /** 累计推理缓冲。 */
  reasoning: string;
  /** 工具调用（插入序 = 调用序）。 */
  toolCalls: Map<string, ToolCallEntry>;
  result?: AgentResult;
  failure?: RunFailure;
  finished: boolean;
}

/** 状态推进排序：pending → running → completed/failed（只前进不回退）。 */
const STATUS_RANK: Record<ToolStatus, number> = { pending: 0, running: 1, completed: 2, failed: 2 };

export class TurnStateMachine {
  state: TurnState = "idle";
  /** 全部回合（含历史，按时间序）。 */
  turns: TurnView[] = [];
  /** 当前正在流式输出的回合；idle 时为 null。 */
  current: TurnView | null = null;
  /** 状态行文本（idle 提示 / 运行提示 / iteration 脚注 / 结果摘要）。 */
  statusText = "idle";
  /** 错误横幅（run_failed / result.stop_reason=error / 后端异常退出）。 */
  errorBanner: string | undefined;
  /** 累计成本（各回合 cost 求和）。 */
  totalCost = 0;
  /** 最近一条斜杠命令的输入（用户输入原样；不参与回合状态机）。 */
  commandInput = "";
  /** 最近一条斜杠命令的输出（join 后，空 = 无输出）。 */
  commandOutput = "";
  /** 命令输出序号：每次 finishCommand 递增，ChatView 据此追加渲染新输出。 */
  commandSeq = 0;

  private nextTurnId = 1;

  get isIdle(): boolean {
    return this.state === "idle";
  }

  /** 回合开始：idle → running。后端正忙时忽略。 */
  startTurn(userMessage: string): void {
    if (this.state !== "idle") return;
    const turn: TurnView = {
      id: this.nextTurnId++,
      userMessage,
      answer: "",
      reasoning: "",
      toolCalls: new Map(),
      finished: false,
    };
    this.turns.push(turn);
    this.current = turn;
    this.state = "running";
    this.errorBanner = undefined;
    this.statusText = "运行中… (Ctrl+C 中断)";
  }

  /** 请求中断：running → cancelling。 */
  requestCancel(): void {
    if (this.state === "running") {
      this.state = "cancelling";
      this.statusText = "正在取消… (Ctrl+C 退出)";
    }
  }

  /** 命令输入已提交：记录输入并清空上次输出（仅 idle 下有效；命令不改变回合状态）。 */
  startCommand(input: string): void {
    if (this.state !== "idle") return;
    this.commandInput = input;
    this.commandOutput = "";
  }

  /** 命令输出到达：记录输出行并递增序号（ChatView 据此追加渲染新输出）。 */
  finishCommand(output: string): void {
    this.commandOutput = output;
    this.commandSeq += 1;
  }

  /** 回合终结（result 到达）：running/cancelling → idle。 */
  finishTurn(result: AgentResult): void {
    const turn = this.current ?? this.turns[this.turns.length - 1];
    if (turn) {
      turn.result = result;
      turn.finished = true;
      if (result.stop_reason === "error" && result.failure) {
        this.errorBanner = result.failure.message;
      }
      if (typeof result.cost === "number") {
        this.totalCost += result.cost;
      }
    }
    this.current = null;
    this.state = "idle";
    const cost = typeof result.cost === "number" ? ` · $${result.cost.toFixed(4)}` : "";
    this.statusText = `✓ ${result.stop_reason}${cost}`;
  }

  /** run_failed：错误横幅 + 记录 failure；回合终结仍由后续 result 负责。 */
  onRunFailed(failure: RunFailure): void {
    this.errorBanner = failure.message;
    if (this.current) {
      this.current.failure = failure;
    }
  }

  /** turn_completed：状态行脚注（iteration / cost）。 */
  onTurnCompleted(info: { iteration: number; usage: TokenUsage; cost?: number; finish_reason: string }): void {
    const cost = typeof info.cost === "number" ? ` · $${info.cost.toFixed(4)}` : "";
    this.statusText = `↻ iteration ${info.iteration}${cost}`;
  }

  /** 后端异常退出等不可恢复情况：把未终结回合标记为失败并回到 idle。 */
  abort(reason: string): void {
    if (this.state !== "idle") {
      const turn = this.current;
      if (turn) {
        turn.finished = true;
        turn.failure = { code: "aborted", message: reason };
      }
      this.current = null;
      this.state = "idle";
    }
    this.errorBanner = reason;
    this.statusText = "已中止";
  }

  /** 清空历史与状态（对应 clear_history 请求）。 */
  clear(): void {
    this.turns = [];
    this.current = null;
    this.state = "idle";
    this.errorBanner = undefined;
    this.totalCost = 0;
    this.statusText = "idle";
  }

  /* ------------------------- 事件 → 视图模型 ------------------------- */

  /** 事件流入口：按 kind 路由到具体变更。 */
  applyEvent(event: AgentEvent): void {
    switch (event.kind) {
      case "text_delta":
        if (this.current) this.current.answer += event.delta;
        break;
      case "reasoning_delta":
        if (this.current) this.current.reasoning += event.delta;
        break;
      case "tool_call_delta":
        if (this.current) {
          this.upsertTool({ id: event.id, name: event.name, arguments: event.arguments }, "pending");
        }
        break;
      case "tool_started":
        if (this.current) this.upsertTool(event.call, "running");
        break;
      case "tool_completed": {
        if (this.current) {
          const entry = this.upsertTool(event.call, event.is_error ? "failed" : "completed");
          entry.observation = event.observation;
        }
        break;
      }
      case "turn_completed":
        this.onTurnCompleted(event);
        break;
      case "run_failed":
        this.onRunFailed(event.failure);
        break;
    }
  }

  /**
   * 按 id 合并工具条目：新条目用给定状态创建，已存在的只更新 arguments/name，
   * 状态只向前推进（pending → running → completed/failed）。
   */
  private upsertTool(call: ToolCall, status: ToolStatus): ToolCallEntry {
    const turn = this.current;
    if (!turn) {
      throw new Error("无活动回合，却收到工具事件");
    }
    let entry = turn.toolCalls.get(call.id);
    if (!entry) {
      entry = { id: call.id, name: call.name, arguments: call.arguments ?? "", status };
      turn.toolCalls.set(call.id, entry);
    } else {
      if (call.name) entry.name = call.name;
      if (call.arguments !== undefined) entry.arguments = call.arguments;
      if (STATUS_RANK[status] > STATUS_RANK[entry.status]) {
        entry.status = status;
      }
    }
    return entry;
  }
}
