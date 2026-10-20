import test from "node:test";
import assert from "node:assert/strict";

import type { LlmFailure } from "@di/ai";
import {
  RETRY_DEFAULTS,
  isRetryableError,
  isRetryableFailure,
  retryDelayMs,
} from "@di/ai";
import { SseStreamError, DeepSeekError, deepSeekErrorCodes } from "@di/ai";

/**
 * P3 card 5 red list — pure retry policy (Di baseline
 * `Core/Llm/RetryingChatModel.cs` `RetryPolicyOptions` + `LlmException.IsRetryable`;
 * models-and-auth.md §重试边界). Classification and wait computation stay
 * provider-neutral: failures are judged by their {@link LlmFailure} shape and SSE
 * transport errors by their {@link SseStreamError} code. Cancellation and
 * first-event boundaries live in the {@link RetryingChatModel} wrapper tests.
 */

test("isRetryableFailure retries 408/429/5xx HTTP statuses", () => {
  assert.equal(isRetryableFailure({ message: "x", code: "INVALID_REQUEST", status: 408 }), true);
  assert.equal(isRetryableFailure({ message: "x", code: "RATE_LIMITED", status: 429 }), true);
  assert.equal(isRetryableFailure({ message: "x", code: "INVALID_REQUEST", status: 500 }), true);
  assert.equal(isRetryableFailure({ message: "x", code: "INVALID_REQUEST", status: 503 }), true);
});

test("isRetryableFailure never retries credential or invalid-request failures", () => {
  assert.equal(isRetryableFailure({ message: "x", code: "MISSING_CREDENTIAL", status: 401 }), false);
  assert.equal(isRetryableFailure({ message: "x", code: "MISSING_CREDENTIAL", status: 403 }), false);
  assert.equal(isRetryableFailure({ message: "x", code: "INVALID_REQUEST", status: 400 }), false);
  assert.equal(isRetryableFailure({ message: "x", code: "UNSUPPORTED_OPTION" }), false);
});

test("isRetryableFailure retries TIMEOUT/CONNECTION/RATE_LIMITED codes without a status", () => {
  assert.equal(isRetryableFailure({ message: "x", code: "TIMEOUT" }), true);
  assert.equal(isRetryableFailure({ message: "x", code: "CONNECTION" }), true);
  assert.equal(isRetryableFailure({ message: "x", code: "RATE_LIMITED" }), true);
});

test("isRetryableError classifies SseStreamError codes", () => {
  assert.equal(isRetryableError(new SseStreamError("connection", "drop")), true);
  assert.equal(isRetryableError(new SseStreamError("timeout", "idle")), true);
  assert.equal(isRetryableError(new SseStreamError("aborted", "cancel")), false);
});

test("isRetryableError classifies failure-carrying errors provider-neutrally", () => {
  assert.equal(
    isRetryableError(new DeepSeekError({ message: "limit", code: deepSeekErrorCodes.rateLimited, status: 429 })),
    true,
  );
  assert.equal(
    isRetryableError(new DeepSeekError({ message: "no key", code: deepSeekErrorCodes.missingCredential, status: 401 })),
    false,
  );
  assert.equal(isRetryableError(new Error("plain")), false);
});

test("retryDelayMs uses Retry-After and caps it at maxBackoffMs", () => {
  const failure: LlmFailure = { message: "x", code: "RATE_LIMITED", providerRetryAfterMs: 5000 };
  const opts = { jitterRatio: 0 };
  assert.equal(retryDelayMs(failure, 1, opts), 5000);
  assert.equal(
    retryDelayMs({ ...failure, providerRetryAfterMs: 500_000 }, 1, { ...opts, maxBackoffMs: 30_000 }),
    30_000,
  );
});

test("retryDelayMs grows exponentially when there is no Retry-After", () => {
  const opts = { initialBackoffMs: 10, backoffMultiplier: 2, maxBackoffMs: 1000, jitterRatio: 0 };
  assert.equal(retryDelayMs(undefined, 1, opts), 10);
  assert.equal(retryDelayMs(undefined, 2, opts), 20);
  assert.equal(retryDelayMs(undefined, 3, opts), 40);
});

test("retryDelayMs applies ±jitterRatio jitter around the delay", () => {
  const opts = { initialBackoffMs: 100, jitterRatio: 0.2 };
  assert.equal(retryDelayMs(undefined, 1, { ...opts, random: () => 0 }), 80);
  assert.equal(retryDelayMs(undefined, 1, { ...opts, random: () => 1 }), 120);
  assert.equal(retryDelayMs(undefined, 1, { ...opts, random: () => 0.5 }), 100);
});

test("RETRY_DEFAULTS mirror the C# RetryPolicyOptions / DeepSeekDefaults", () => {
  assert.equal(RETRY_DEFAULTS.maxAttempts, 3);
  assert.equal(RETRY_DEFAULTS.initialBackoffMs, 500);
  assert.equal(RETRY_DEFAULTS.maxBackoffMs, 30_000);
  assert.equal(RETRY_DEFAULTS.backoffMultiplier, 2);
  assert.equal(RETRY_DEFAULTS.jitterRatio, 0.2);
});

test("retryDelayMs without options stays within the default backoff jitter window", () => {
  const delay = retryDelayMs(undefined, 1);
  assert.ok(delay >= 400 && delay <= 600, `expected ~500ms, got ${delay}`);
});
