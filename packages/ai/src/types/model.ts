import type { AgentMessage, AssistantMessage } from "./messages.ts";
import type { ToolSpec } from "./tools.ts";
import type { ModelEvent } from "./stream.ts";

/**
 * Token accounting for one model call (from Di baseline `Core/Llm/TokenUsage.cs`).
 * Counts are mutually exclusive: `inputTokens` excludes cache hits, which are
 * reported separately; `reasoningTokens` is a subset of `outputTokens`.
 * Nullable fields mean "not reported" and must not be defaulted to zero.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

/** Cost breakdown of one model call in USD (from `Core/Llm/CostAccounting.cs` `UsageCost`). */
export interface UsageCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Serializable provider/transport failure fact (from `Core/Llm/FinishReason.cs` `LlmFailure`). */
export interface LlmFailure {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
  /** Provider Retry-After, in milliseconds. */
  readonly providerRetryAfterMs?: number;
  readonly requestId?: string;
}

/** Why the model stopped generating (from `Core/Llm/FinishReason.cs`). */
export type FinishReason =
  | { readonly type: "stop" }
  | { readonly type: "tool-calls" }
  | { readonly type: "max-tokens" }
  | { readonly type: "aborted"; readonly failure: LlmFailure }
  | { readonly type: "error"; readonly failure: LlmFailure };

/** A provider route and its opaque model id (from `Core/Llm/ModelReference.cs`). */
export interface ModelRef {
  readonly provider: string;
  readonly id: string;
}

/** One model request (from `Core/Llm/ModelRequest.cs` + architecture.md sketch). */
export interface ModelRequest {
  readonly messages: readonly AgentMessage[];
  readonly tools?: readonly ToolSpec[];
  readonly maxTokens?: number;
  readonly reasoningEffort?: string;
}

/** One complete response to a model call (from `Core/Llm/ModelResponse.cs`). */
export interface ModelResponse {
  readonly message: AssistantMessage;
  readonly finishReason: FinishReason;
  readonly usage: TokenUsage;
  readonly model: string;
  readonly cost?: UsageCost;
  readonly responseId?: string;
  /** Request start, Unix milliseconds. */
  readonly timestamp: number;
  /** Request duration in milliseconds, monotonic clock. */
  readonly durationMs?: number;
}

/** Streaming model boundary consumed by the agent loop (from `Core/Llm/IChatModel.cs`). */
export interface ChatModel {
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}
