/*
 * — retry/timeout policy (`packages/ai/src/retry/`).
 *
 * A provider-neutral retry wrapper around any {@link ChatModel}, matching the
 * with the TS boundary fix from
 * models-and-auth.md §重试边界: retry only before the first {@link ModelEvent},
 * cancellation never retries, Retry-After / exponential backoff / header-wait
 * and SSE idle timeouts are honored, and a retried request never replays tool
 * execution.
 */

export {
  RETRY_DEFAULTS,
  resolveRetryOptions,
  isRetryableFailure,
  isRetryableError,
  failureOf,
  retryDelayMs,
} from "./policy.ts";
export type { RetryPolicyOptions } from "./policy.ts";

export { RetryingChatModel, defaultRetrySleep } from "./retrying-model.ts";
export type { RetrySleep } from "./retrying-model.ts";
