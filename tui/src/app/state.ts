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

import type { AgentEvent, AgentResult, ModelInfo, ReadyMessage, RunFailure, SkillInfo, TokenUsage, ToolCall } from "../rpc/protocol.ts";

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

/**
 * 把 TokenUsage 格式化为 REPL 同款（对齐 Core/Llm/TokenUsage.cs ToString / EventRenderer.cs:140）：
 * `in=X (cache_read=Y) out=Z (reasoning=R) total=T`。可空键缺省视作 0（对齐 C# `?? 0`）；
 * total 缺省时按计费输入 + 输出兜底（计费输入 = 未命中 + 命中读 + 命中写）。
 */
function formatTokenUsage(usage: TokenUsage): string {
  const known = (value: number | undefined) => value === undefined ? "N/A" : String(value);
  const cacheRead = known(usage.cache_read_tokens);
  const billable = usage.input_tokens + cacheRead + (usage.cache_write_tokens ?? 0);
  const total = usage.total_tokens === undefined ? String(billable + usage.output_tokens) : String(usage.total_tokens);
  const writes = (usage.cache_write_tokens ?? 0) > 0 ? ` cache_write=${usage.cache_write_tokens}` : "";
  return `in=${usage.input_tokens} (cache_read=${cacheRead}${writes}) out=${usage.output_tokens} (reasoning=${known(usage.reasoning_tokens)}) total=${total}`;
}

export class TurnStateMachine {
  state: TurnState = "idle";
  /** 全部回合（含历史，按时间序）。 */
  turns: TurnView[] = [];
  /** 当前正在流式输出的回合；idle 时为 null。 */
  current: TurnView | null = null;
  /** 状态行文本（idle 提示 / 运行提示 / iteration 脚注 / 结果摘要）。空串 = 不显示（dock 中塌缩）。 */
  statusText = "";
  /** 错误横幅（run_failed / result.stop_reason=error / 后端异常退出）。 */
  errorBanner: string | undefined;
  /** 累计成本（各回合 cost 求和）。 */
  totalCost = 0;
  private cacheReadTotal = 0;
  private cacheInputTotal = 0;
  private cacheUsageSeen = false;
  private cacheUsageComplete = true;
  private costUsageComplete = true;
  private completedTurns = 0;
  private turnUsage: TokenUsage | undefined;
  private turnCost: number | undefined;
  private sessionInput = 0;
  private sessionOutput = 0;
  private sessionTotal = 0;
  private sessionTotalComplete = true;
  private sessionUsageTurns = 0;
  private sessionCacheRead = 0;
  private sessionCacheReadComplete = true;
  private sessionCacheWrite = 0;
  private sessionCacheWriteComplete = true;
  private sessionReasoning = 0;
  private sessionReasoningComplete = true;
  /** 最近一条斜杠命令的输入（用户输入原样；不参与回合状态机）。 */
  commandInput = "";
  /** 最近一条斜杠命令的输出（join 后，空 = 无输出）。 */
  commandOutput = "";
  /** 命令输出序号：每次 finishCommand 递增，ChatView 据此追加渲染新输出。 */
  commandSeq = 0;

  /* ---- 会话元数据（ready 握手 + command_ran 快照；右下角状态栏与命令补全） ---- */

  /** 当前模型名（/model 可切换）。 */
  model = "";
  /** 推理强度（off/low/high/max 等，启动固定；null = 未配置）。 */
  effort: string | null = null;
  /** 可见 skills（/skill 补全）。 */
  skills: SkillInfo[] = [];
  /** 模型目录（/model 参数补全）。 */
  models: ModelInfo[] = [];

  private nextTurnId = 1;

  get isIdle(): boolean {
    return this.state === "idle";
  }

  /** ready 握手写入会话元数据（模型/强度/skills/模型目录）。 */
  setMeta(meta: ReadyMessage): void {
    this.model = meta.model ?? "";
    this.effort = meta.effort ?? null;
    this.skills = meta.skills ?? [];
    this.models = meta.models ?? [];
  }

  /** command_ran 快照更新模型/强度（如 /model 切换后）。 */
  applyModel(model: string, effort: string | null): void {
    this.model = model;
    this.effort = effort;
  }

  /** 右下角状态栏标签：`模型 · 强度`（无强度仅模型名）。 */
  modelLabel(): string {
    return this.model ? (this.effort ? `${this.model} · ${this.effort}` : this.model) : "";
  }

  cacheHitRateLabel(): string {
    const currentRead = this.turnUsage?.cache_read_tokens;
    if (this.state !== "idle" && this.turnUsage && currentRead === undefined) return "N/A";
    const currentInput = this.state !== "idle" && this.turnUsage && currentRead !== undefined
      ? this.turnUsage.input_tokens + currentRead + (this.turnUsage.cache_write_tokens ?? 0) : 0;
    const currentCacheRead = currentRead ?? 0;
    const known = this.cacheUsageComplete && (this.state === "idle" || !this.turnUsage || currentRead !== undefined);
    const denominator = this.cacheInputTotal + currentInput;
    return this.cacheUsageSeen || currentRead !== undefined
      ? known && denominator > 0 ? `${(((this.cacheReadTotal + currentCacheRead) / denominator) * 100).toFixed(1)}%` : "N/A"
      : "N/A";
  }

  contextUsageLabel(): string {
    return "N/A";
  }

  totalCostLabel(): string {
    if (this.state !== "idle") return this.turnCost !== undefined && this.costUsageComplete ? `$${(this.totalCost + this.turnCost).toFixed(4)}` : "N/A";
    return this.completedTurns > 0 && this.costUsageComplete ? `$${this.totalCost.toFixed(4)}` : "N/A";
  }

  usageSummary(): string {
    const cost = this.totalCostLabel();
    const total = this.sessionUsageTurns > 0 && this.sessionTotalComplete ? String(this.sessionTotal) : "N/A";
    const cacheRead = this.sessionUsageTurns && this.sessionCacheReadComplete ? this.sessionCacheRead : "N/A";
    const cacheWrite = this.sessionUsageTurns && this.sessionCacheWriteComplete ? this.sessionCacheWrite : "N/A";
    const reasoning = this.sessionUsageTurns && this.sessionReasoningComplete ? this.sessionReasoning : "N/A";
    return `会话累计 input: ${this.sessionUsageTurns ? this.sessionInput : "N/A"} · output: ${this.sessionUsageTurns ? this.sessionOutput : "N/A"} · total: ${total}\ncache_read: ${cacheRead} · cache_write: ${cacheWrite} · reasoning: ${reasoning}\n会话累计 Cache 命中率: ${this.cacheHitRateLabel()}\n会话累计 Cost: ${cost}\n当前上下文用量: ${this.contextUsageLabel()}`;
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
      } else this.costUsageComplete = false;
      this.completedTurns += 1;
      const syntheticZero = result.usage.input_tokens === 0 && result.usage.output_tokens === 0 && result.usage.total_tokens === undefined;
      const usage = syntheticZero && this.turnUsage ? this.turnUsage : result.usage;
      this.sessionInput += usage.input_tokens;
      this.sessionOutput += usage.output_tokens;
      if (usage.total_tokens === undefined) this.sessionTotalComplete = false;
      else this.sessionTotal += usage.total_tokens;
      this.sessionUsageTurns += 1;
      if (usage.cache_read_tokens === undefined) this.sessionCacheReadComplete = false;
      else this.sessionCacheRead += usage.cache_read_tokens;
      if (usage.cache_write_tokens === undefined) this.sessionCacheWriteComplete = false;
      else this.sessionCacheWrite += usage.cache_write_tokens;
      if (usage.reasoning_tokens === undefined) this.sessionReasoningComplete = false;
      else this.sessionReasoning += usage.reasoning_tokens;
      if (usage.cache_read_tokens !== undefined) { this.cacheUsageSeen = true; this.cacheReadTotal += usage.cache_read_tokens; }
      else this.cacheUsageComplete = false;
      // 对齐 Core TokenUsage.CacheHitRate：未上报 cache-write 时按 0 参与分母；该分项本身仍保持 N/A。
      if (usage.cache_read_tokens !== undefined) this.cacheInputTotal += usage.input_tokens + usage.cache_read_tokens + (usage.cache_write_tokens ?? 0);
    }
    this.current = null;
    this.turnUsage = undefined;
    this.turnCost = undefined;
    this.state = "idle";
    // 左下角状态行记录本回合统计摘要（对齐 REPL 展示，EventRenderer.cs:140 同源；cost F6）。
    // 取消回合不产生有效统计，单独提示。
    if (result.stop_reason === "cancelled") {
      this.statusText = "已取消";
    } else {
      const cost = typeof result.cost === "number" ? ` · cost:$${result.cost.toFixed(6)}` : "";
      this.statusText = `${result.iterations} 轮 · tokens: ${formatTokenUsage(result.usage)}${cost}`;
    }
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
    // ReAct 的 turn_completed.usage 是截至 iteration 的累计快照，不是 delta。
    this.turnUsage = info.usage;
    this.turnCost = info.cost;
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
    this.statusText = "";
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
