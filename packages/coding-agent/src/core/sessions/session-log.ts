/*
 * JSONL session writer.
 *
 * 逐行 envelope" / §"实时 checkpoint record 与完整示例"; *.
 *
 * The writer owns the session file: `~/.di/sessions/YYYY/MM/DD/session-{utc}-{id8}.jsonl`
 * (UTC, never local time), the idempotent `session_meta` first line, the monotonic
 * ordinals and the raw-UTF-8 / LF / no-BOM line output. The checkpoint methods are
 * the loop's durable seam: `checkpoint_tool_started` is written BEFORE a tool may
 * run (a failed write propagates and the tool never executes), and only after a
 * `checkpoint_tool_completed` write is the result a durable completion fact. The
 * audit methods (`appendTurn` / `appendFailure`) mirror the `response_item`
 * sequence for `di --stats`.
 *
 * Single-writer per file (appendFileSync is synchronous; ordinals never interleave).
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMessage, ContentBlock, ReasoningBlock, TokenUsage, ToolCall, ToolResultMessage, UsageCost } from "@di/ai";
import { textOfMessage } from "@di/ai";
import type { AgentResult, LoopCheckpoint } from "@di/agent";
import { nowUtcIso, serializeCheckpointMessage, serializeEnvelope } from "./codec.ts";

/** Session persistence options; defaults mirror `SessionLogOptions`. */
export interface SessionLogOptions {
  /** Session root (resolved DI_HOME); the log lives under `sessions/YYYY/MM/DD/`. */
  readonly rootDirectory: string;
  /** Written into `config.json` and `session_meta`; default "0.1.0". */
  readonly cliVersion?: string;
  /** `session_meta` originator; default "di". */
  readonly originator?: string;
  /** `session_meta` source channel; default "cli". */
  readonly source?: string;
  /** `session_meta` model provider; default "deepseek". */
  readonly modelProvider?: string;
  /** Injectable UTC clock (ISO string) for deterministic tests; default `new Date.toISOString`. */
  readonly now?: () => string;
}

/** Minimal turn-completion facts the checkpoint marker needs (from `AgentResult`). */
export interface CheckpointTurnCompletion {
  readonly stopReason: string;
  readonly iterations: number;
}

/** The JSONL session writer; also the loop's durable `LoopCheckpoint` seam. */
export class SessionStore implements LoopCheckpoint {
  /** Unique id for this session (32 lowercase hex, like `Guid.ToString("N")`). */
  readonly sessionId: string;
  /** Full path of this session's JSONL file (derived from the UTC now, never local time). */
  readonly logFilePath: string;

  private readonly options_: SessionLogOptions;
  private ordinal_ = 0;
  private started_ = false;

  constructor(options: SessionLogOptions) {
    if (options == null || options.rootDirectory == null) {
      throw new TypeError("SessionStore: rootDirectory is required");
    }
    this.options_ = options;
    this.sessionId = randomUUID().replace(/-/g, "");
    this.logFilePath = buildFilePath(options.rootDirectory, this.sessionId);
    mkdirSync(dirname(this.logFilePath), { recursive: true });
  }

  /** Number of records written (ordinal count). */
  get recordCount(): number {
    return this.ordinal_;
  }

  /** Write the `session_meta` first line; idempotent. */
  startSession(): void {
    if (this.started_) return;
    this.started_ = true;
    this.append_("session_meta", {
      session_id: this.sessionId,
      id: this.sessionId,
      timestamp: this.now_(),
      cwd: process.cwd(),
      originator: this.options_.originator ?? "di",
      cli_version: this.options_.cliVersion ?? "0.1.0",
      source: this.options_.source ?? "cli",
      thread_source: "user",
      model_provider: this.options_.modelProvider ?? "deepseek",
    });
  }

  /** Write the user request + full history snapshot as a recoverable turn start. */
  beginCheckpointTurn(userMessage: string, startedAt: number, history: readonly AgentMessage[] = []): void {
    this.startSession();
    this.append_("checkpoint_turn_started", {
      started_at: startedAt,
      history: history.map(serializeCheckpointMessage),
      user: serializeCheckpointMessage({ role: "user", content: [{ type: "text", text: userMessage }] }),
    });
  }

  /** Write and flush one complete assistant/system/user message checkpoint as one record. */
  appendCheckpointMessage(message: AgentMessage): void {
    this.startSession();
    this.append_("trajectory_checkpoint", { message: serializeCheckpointMessage(message) });
  }

  /** Durably record tool intent. Callers must not execute the tool if this write fails. */
  checkpointToolStarted(call: ToolCall): void {
    this.startSession();
    this.append_("checkpoint_tool_started", {
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  }

  /** Durably record a tool outcome, closing its pending intent. */
  checkpointToolCompleted(result: ToolResultMessage): void {
    this.startSession();
    this.append_("checkpoint_tool_completed", {
      call_id: result.toolCallId,
      message: serializeCheckpointMessage(result),
    });
  }

  /** Record a recoverable turn boundary and its stop details. */
  completeCheckpointTurn(result: CheckpointTurnCompletion): void {
    this.startSession();
    this.append_("checkpoint_turn_completed", {
      stop_reason: result.stopReason,
      iterations: result.iterations,
    });
  }

  // ---- LoopCheckpoint adapter (the durable seam `runAgentLoop` calls) ----

  appendMessage(message: AgentMessage): void {
    this.appendCheckpointMessage(message);
  }

  toolStarted(call: ToolCall): void {
    this.checkpointToolStarted(call);
  }

  toolCompleted(result: ToolResultMessage): void {
    this.checkpointToolCompleted(result);
  }

  // ---- audit path (di --stats) ----

  /** Append one complete turn's audit records (task_started / turn_context / response_items / task_complete). */
  appendTurn(result: AgentResult, startedAt: number): void {
    this.startSession();
    const turnId = randomUUID().replace(/-/g, "");
    const completedAt = Date.now();
    this.append_("event_msg", { type: "task_started", turn_id: turnId, started_at: startedAt });
    this.append_("turn_context", { turn_id: turnId, cwd: process.cwd() });
    // Messages before result.history were already written in previous turns.
    for (const message of result.trajectory.slice(result.history.length)) {
      this.appendAuditMessage_(message);
    }
    this.append_("event_msg", {
      type: "task_complete",
      turn_id: turnId,
      last_agent_message: result.answer,
      stop_reason: result.stopReason,
      iterations: result.iterations,
      completed_at: completedAt,
      duration_ms: Math.max(0, completedAt - startedAt),
      ...(result.cost !== undefined ? { cost: serializeCost(result.cost) } : {}),
      usage: serializeUsage(result.usage),
    });
  }

  /** Append a failed turn (task_started / turn_context / user / task_failed) — a failure must leave a trace. */
  appendFailure(userMessage: string, errorMessage: string, startedAt: number): void {
    this.startSession();
    const turnId = randomUUID().replace(/-/g, "");
    const completedAt = Date.now();
    this.append_("event_msg", { type: "task_started", turn_id: turnId, started_at: startedAt });
    this.append_("turn_context", { turn_id: turnId, cwd: process.cwd() });
    this.append_("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: userMessage }],
    });
    this.append_("event_msg", {
      type: "task_failed",
      turn_id: turnId,
      error: errorMessage,
      completed_at: completedAt,
      duration_ms: Math.max(0, completedAt - startedAt),
    });
  }

  /** Translate one trajectory message into zero or more `response_item` records. */
  private appendAuditMessage_(message: AgentMessage): void {
    switch (message.role) {
      case "user":
        this.append_("response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: textOfMessage(message) }],
        });
        break;
      case "assistant": {
        const reasoning = message.content.filter(isReasoningBlock).map((block) => block.text).join("");
        if (reasoning.length > 0) {
          this.append_("response_item", {
            type: "reasoning",
            summary: [{ type: "summary_text", text: reasoning }],
          });
        }
        const text = textOfMessage(message);
        if (text.length > 0) {
          this.append_("response_item", {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          });
        }
        for (const call of message.content.filter(isToolCall)) {
          this.append_("response_item", {
            type: "function_call",
            name: call.name,
            arguments: call.arguments,
            call_id: call.id,
          });
        }
        break;
      }
      case "tool":
        this.append_("response_item", {
          type: "function_call_output",
          call_id: message.toolCallId,
          output: message.content,
        });
        break;
      case "system":
        break; // no audit item for system messages
    }
  }

  private now_(): string {
    return this.options_.now?.() ?? nowUtcIso();
  }

  private append_(type: string, payload: Record<string, unknown>): void {
    const line = serializeEnvelope(type, payload, this.ordinal_, this.now_());
    this.ordinal_ += 1;
    appendFileSync(this.logFilePath, line + "\n", "utf8");
  }
}

function isReasoningBlock(block: ContentBlock): block is ReasoningBlock {
  return block.type === "reasoning";
}

function isToolCall(block: ContentBlock): block is ToolCall {
  return block.type === "tool-call";
}

/** Wire usage shape: token counts + billable + cache hit rate (TokenUsage serialization). */
function serializeUsage(usage: TokenUsage): Record<string, unknown> {
  const billable = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cache_read_tokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cache_write_tokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoning_tokens: usage.reasoningTokens } : {}),
    billable_input_tokens: billable,
    ...(billable > 0 ? { cache_hit_rate: (usage.cacheReadTokens ?? 0) / billable } : {}),
  };
}

/** Wire cost shape: the four components + the computed total. */
function serializeCost(cost: UsageCost): Record<string, unknown> {
  return {
    input: cost.input,
    output: cost.output,
    cache_read: cost.cacheRead,
    cache_write: cost.cacheWrite,
    total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite,
  };
}

/** Build `sessions/YYYY/MM/DD/session-{utc}-{sessionId前8位}.jsonl` from the UTC clock. */
function buildFilePath(root: string, sessionId: string): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const yyyy = String(now.getUTCFullYear());
  const mm = pad(now.getUTCMonth() + 1);
  const dd = pad(now.getUTCDate());
  const stamp = `${yyyy}-${mm}-${dd}T${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`;
  const dir = join(root, "sessions", yyyy, mm, dd);
  return join(dir, `session-${stamp}-${sessionId.slice(0, 8)}.jsonl`);
}
