import type { LlmFailure } from "../types/model.ts";
import { SseStreamError } from "../sse.ts";

/**
 * Retry/timeout policy for model streams (Di baseline
 * `Core/Llm/RetryingChatModel.cs` `RetryPolicyOptions` + `LlmException.IsRetryable`;
 * models-and-auth.md §重试边界).
 *
 * The policy is provider-neutral: it classifies structured failures by their
 * {@link LlmFailure} shape and SSE transport errors by their
 * {@link SseStreamError} code. The first-`ModelEvent` retry boundary and the
 * cancellation rule live in {@link RetryingChatModel}; this module only decides
 * "is this failure worth a retry" and "how long to wait".
 */

/** Defaults mirroring the C# `RetryPolicyOptions` / `DeepSeekDefaults`. */
export const RETRY_DEFAULTS = {
  /** Total attempts including the first (C# `MaxAttempts` = 3). */
  maxAttempts: 3,
  /** First retry delay in ms when the provider sends no Retry-After (C# `InitialBackoff` = 500ms). */
  initialBackoffMs: 500,
  /** Backoff cap in ms; also caps Retry-After so a hostile header cannot stall a turn (C# `MaxBackoff` = 30s). */
  maxBackoffMs: 30_000,
  /** Exponential backoff multiplier per attempt (C# `BackoffMultiplier` = 2). */
  backoffMultiplier: 2,
  /** Jitter fraction applied to every wait, ±`jitterRatio` (C# ±20%). */
  jitterRatio: 0.2,
} as const;

/**
 * Retry configuration for one model call. Every field is optional; the
 * C#-mirroring defaults in {@link RETRY_DEFAULTS} fill the gaps.
 */
export interface RetryPolicyOptions {
  /** Total attempts including the first; `1` means "no retry". Default 3. */
  readonly maxAttempts?: number;
  /** First retry delay in ms when the provider sends no Retry-After. Default 500. */
  readonly initialBackoffMs?: number;
  /** Per-wait cap in ms; also caps Retry-After. Default 30_000. */
  readonly maxBackoffMs?: number;
  /** Exponential backoff multiplier applied per attempt. Default 2. */
  readonly backoffMultiplier?: number;
  /** Jitter fraction applied to every wait (±). Default 0.2. */
  readonly jitterRatio?: number;
  /** Uniform random source for jitter; inject a fixed value for deterministic waits. */
  readonly random?: () => number;
}

/** Resolve partial options against the {@link RETRY_DEFAULTS}. */
export function resolveRetryOptions(options: RetryPolicyOptions = {}): Required<RetryPolicyOptions> {
  return {
    maxAttempts: options.maxAttempts ?? RETRY_DEFAULTS.maxAttempts,
    initialBackoffMs: options.initialBackoffMs ?? RETRY_DEFAULTS.initialBackoffMs,
    maxBackoffMs: options.maxBackoffMs ?? RETRY_DEFAULTS.maxBackoffMs,
    backoffMultiplier: options.backoffMultiplier ?? RETRY_DEFAULTS.backoffMultiplier,
    jitterRatio: options.jitterRatio ?? RETRY_DEFAULTS.jitterRatio,
    random: options.random ?? Math.random,
  };
}

/**
 * Whether an {@link LlmFailure} is worth retrying (mirrors C#
 * `LlmException.IsRetryable`): 408/429/5xx HTTP statuses, or a
 * `TIMEOUT` / `CONNECTION` / `RATE_LIMITED` code. Credential and invalid-request
 * failures are never retried (they cannot succeed on a second attempt).
 */
export function isRetryableFailure(failure: LlmFailure): boolean {
  const status = failure.status;
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }
  return (
    failure.code === "TIMEOUT" ||
    failure.code === "CONNECTION" ||
    failure.code === "RATE_LIMITED"
  );
}

/**
 * Extract the {@link LlmFailure} carried by a structured provider error
 * (provider-neutral: any error whose `failure` field looks like an
 * `LlmFailure`). Returns `undefined` for plain errors and transport errors that
 * carry their own code instead (e.g. {@link SseStreamError}).
 */
export function failureOf(error: unknown): LlmFailure | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const failure = (error as { readonly failure?: unknown }).failure;
  if (typeof failure !== "object" || failure === null) return undefined;
  const record = failure as { readonly message?: unknown; readonly code?: unknown };
  if (typeof record.message === "string" && typeof record.code === "string") {
    return failure as LlmFailure;
  }
  return undefined;
}

/**
 * Whether a thrown error is retryable. Recognizes:
 * - {@link SseStreamError} `"connection"` (stream read failed / EOF without a
 *   terminal finish) and `"timeout"` (SSE idle timeout); `"aborted"` is never
 *   retried;
 * - any error carrying an {@link LlmFailure} (DeepSeekError and future provider
 *   errors) via {@link failureOf}, judged by {@link isRetryableFailure}.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof SseStreamError) {
    return error.code === "connection" || error.code === "timeout";
  }
  const failure = failureOf(error);
  return failure !== undefined && isRetryableFailure(failure);
}

/**
 * How long to wait before the next attempt (C# `RetryingChatModel.SleepAsync`):
 * the provider's Retry-After (`failure.providerRetryAfterMs`) when present, else
 * exponential backoff `initial * multiplier^(attempt-1)`. Both are capped at
 * `maxBackoffMs` and jittered by ±`jitterRatio`. `attempt` is the 1-based number
 * of the attempt that just failed.
 */
export function retryDelayMs(
  failure: LlmFailure | undefined,
  attempt: number,
  options: RetryPolicyOptions = {},
): number {
  const resolved = resolveRetryOptions(options);
  const retryAfter = failure?.providerRetryAfterMs;
  const backoff = resolved.initialBackoffMs * Math.pow(resolved.backoffMultiplier, attempt - 1);
  const candidate = retryAfter !== undefined ? retryAfter : backoff;
  const capped = Math.min(candidate, resolved.maxBackoffMs);
  const jitter = 1 - resolved.jitterRatio + resolved.random() * 2 * resolved.jitterRatio;
  return Math.max(0, Math.round(capped * jitter));
}
