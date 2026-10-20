import type { ChatModel, ModelRequest } from "../types/model.ts";
import type { ModelEvent } from "../types/stream.ts";
import { SseStreamError } from "../sse.ts";
import {
  failureOf,
  isRetryableError,
  resolveRetryOptions,
  retryDelayMs,
} from "./policy.ts";
import type { RetryPolicyOptions } from "./policy.ts";

/** A retry wait honoring the caller's AbortSignal (inject for deterministic tests). */
export type RetrySleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * Default wait: a plain timer raced against the AbortSignal. When the signal
 * fires mid-wait the wait rejects with an `"aborted"` {@link SseStreamError} and
 * the timer is cleared (it never outlives the wait).
 */
export const defaultRetrySleep: RetrySleep = async (ms, signal) => {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SseStreamError("aborted", "retry wait aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new SseStreamError("aborted", "retry wait aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

/**
 * {@link ChatModel} decorator applying a bounded retry policy to one model call
 * (Di baseline `Core/Llm/RetryingChatModel.cs`, boundary fixed per
 * models-and-auth.md §重试边界).
 *
 * Retrying happens entirely in the transport: the agent loop never sees a retry,
 * only a success, a non-retryable error, or the last retryable error after
 * `maxAttempts`. A retried request therefore never replays tool execution —
 * tools run in the loop (after a `completed` response), never here, and this
 * wrapper stops retrying at the moment the first {@link ModelEvent} (any delta)
 * has been delivered downstream.
 *
 * Rules:
 * - retryable failures are HTTP 408/429/5xx, `RATE_LIMITED`, `TIMEOUT` /
 *   `CONNECTION` failure codes, and {@link SseStreamError} codes `"connection"`
 *   / `"timeout"` (SSE idle timeout);
 * - the wait is the provider's Retry-After (`failure.providerRetryAfterMs`) when
 *   present, else exponential backoff — both capped at `maxBackoffMs`, with
 *   ±`jitterRatio` jitter;
 * - caller cancellation (AbortSignal) never retries; an abort during the wait
 *   propagates as an `"aborted"` error;
 * - once any `ModelEvent` has been yielded downstream, a later stream failure is
 *   rethrown untouched (no re-enumeration, no replayed prefix).
 */
export class RetryingChatModel implements ChatModel {
  private readonly inner: ChatModel;
  private readonly options: Required<RetryPolicyOptions>;
  private readonly sleep: RetrySleep;

  constructor(
    inner: ChatModel,
    options: RetryPolicyOptions = {},
    sleep: RetrySleep = defaultRetrySleep,
  ) {
    this.inner = inner;
    this.options = resolveRetryOptions(options);
    this.sleep = sleep;
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) {
        throw new SseStreamError("aborted", "model stream aborted");
      }
      let emitted = false;
      try {
        for await (const event of this.inner.stream(request, signal)) {
          emitted = true;
          yield event;
        }
        return; // clean completion — no retry.
      } catch (error) {
        // Retry boundary: once the first ModelEvent is out, no re-enumeration —
        // a retry would replay already-published content and could re-issue tool
        // calls the loop had begun from an earlier toolCallDelta.
        if (emitted) {
          throw error;
        }
        // Cancellation is never a retryable condition.
        if (signal?.aborted) {
          throw error;
        }
        if (attempt >= this.options.maxAttempts) {
          throw error;
        }
        if (!isRetryableError(error)) {
          throw error;
        }
        const delay = retryDelayMs(failureOf(error), attempt, this.options);
        await this.sleep(delay, signal);
      }
    }
  }
}
