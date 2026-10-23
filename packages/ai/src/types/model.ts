import type { AgentMessage, AssistantMessage } from "./messages.ts";
import type { ToolSpec } from "./tools.ts";
import type { ModelEvent } from "./stream.ts";

/*
 * Token accounting for one model call.
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

/** Cost breakdown of one model call in USD (from `UsageCost`). */
export interface UsageCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Serializable provider/transport failure fact (from `LlmFailure`). */
export interface LlmFailure {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
  /** Provider Retry-After, in milliseconds. */
  readonly providerRetryAfterMs?: number;
  readonly requestId?: string;
}

/** Why the model stopped generating. */
export type FinishReason =
  | { readonly type: "stop" }
  | { readonly type: "tool-calls" }
  | { readonly type: "max-tokens" }
  | { readonly type: "aborted"; readonly failure: LlmFailure }
  | { readonly type: "error"; readonly failure: LlmFailure };

/** A provider route and its opaque model id. */
export interface ModelRef {
  readonly provider: string;
  readonly id: string;
}

/** One model request (from + architecture.md sketch). */
export interface ModelRequest {
  readonly messages: readonly AgentMessage[];
  readonly tools?: readonly ToolSpec[];
  readonly maxTokens?: number;
  readonly reasoningEffort?: string;
  /*
 * Sampling temperature. Providers that do not support it reject the request
 * with `UNSUPPORTED_OPTION` before sending (`GenerateOptions.Temperature`).
 */
  readonly temperature?: number;
  /** Nucleus sampling (`GenerateOptions.TopP`). */
  readonly topP?: number;
  /** Frequency penalty (`GenerateOptions.FrequencyPenalty`). */
  readonly frequencyPenalty?: number;
  /** Presence penalty (`GenerateOptions.PresencePenalty`). */
  readonly presencePenalty?: number;
  /** Stop sequences (`GenerateOptions.Stop`). */
  readonly stop?: readonly string[];
  /*
 * Business session id used to derive a stable provider prompt-cache key
 * (`GenerateOptions.SessionId` → `prompt_cache_key`). Advisory: the key is a
 * cache-affinity hint, never a hit guarantee (docs/modules/chatgpt.md).
 */
  readonly sessionId?: string;
}

/** One complete response to a model call. */
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

/** Streaming model boundary consumed by the agent loop. */
export interface ChatModel {
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}
