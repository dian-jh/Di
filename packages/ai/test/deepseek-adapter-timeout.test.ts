import test from "node:test";
import assert from "node:assert/strict";

import type { ModelRequest } from "@di/ai";
import { DeepSeekAdapter, DeepSeekError } from "@di/ai";

/**
 * P3 card 5 red list — DeepSeek adapter transport timeouts and connection
 * mapping (Di baseline `Core/Providers/DeepSeek/DeepSeekAdapter.cs` `SendAsync` +
 * `DeepSeekDefaults.RequestTimeoutSeconds`; models-and-auth.md §DeepSeek 协议边界
 * item 4). The header-wait timeout is NOT a total-duration timeout: it only
 * covers the phase before response headers arrive, and caller cancellation
 * always wins over the timer. Retry/backoff itself lives in the retry wrapper.
 */

const request: ModelRequest = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function streamOf(...chunks: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encode(chunk));
      controller.close();
    },
  });
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<readonly T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test("a server that never sends response headers fails with a retryable TIMEOUT", async () => {
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      // Late success is only reachable when the header-wait timeout is ignored.
      setTimeout(() => {
        resolve(
          new Response(
            streamOf(
              'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
              "data: [DONE]\n\n",
            ),
            { status: 200 },
          ),
        );
      }, 200);
    });
  const adapter = new DeepSeekAdapter({ model: "m", apiKey: "k", fetch: fetchImpl, headerTimeoutMs: 50 });

  await assert.rejects(
    collect(adapter.stream(request)),
    (err) => err instanceof DeepSeekError && err.code === "TIMEOUT",
  );
});

test("a fetch-level connection failure maps to a retryable CONNECTION error", async () => {
  const fetchImpl = async (): Promise<Response> => {
    throw new TypeError("fetch failed");
  };
  const adapter = new DeepSeekAdapter({ model: "m", apiKey: "k", fetch: fetchImpl });

  await assert.rejects(
    collect(adapter.stream(request)),
    (err) => err instanceof DeepSeekError && err.code === "CONNECTION" && err.failure.message.includes("fetch failed"),
  );
});

test("parses an HTTP-date Retry-After into providerRetryAfterMs", async () => {
  const retryAfterDate = new Date(Date.now() + 5000).toUTCString();
  const fetchImpl = async (): Promise<Response> =>
    new Response('{"error":{"message":"Rate limit exceeded","type":"rate_limit_exceeded"}}', {
      status: 429,
      headers: { "retry-after": retryAfterDate },
    });
  const adapter = new DeepSeekAdapter({ model: "m", apiKey: "k", fetch: fetchImpl });

  await assert.rejects(
    collect(adapter.stream(request)),
    (err) =>
      err instanceof DeepSeekError &&
      err.code === "RATE_LIMITED" &&
      typeof err.providerRetryAfterMs === "number" &&
      err.providerRetryAfterMs >= 4000 &&
      err.providerRetryAfterMs <= 6000,
  );
});

test("caller cancellation during the header wait propagates as an abort, not a timeout", async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  const adapter = new DeepSeekAdapter({ model: "m", apiKey: "k", fetch: fetchImpl, headerTimeoutMs: 50 });

  const rejection = collect(adapter.stream(request, controller.signal));
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(rejection, (err) => (err as Error).name === "AbortError");
});

test("an already-aborted signal fails the request as an abort, never a timeout", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetchCalled = false;
  // Mirrors real fetch: an already-aborted signal rejects before any network IO.
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      fetchCalled = true;
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  const adapter = new DeepSeekAdapter({ model: "m", apiKey: "k", fetch: fetchImpl, headerTimeoutMs: 50 });

  await assert.rejects(
    collect(adapter.stream(request, controller.signal)),
    (err) => (err as Error).name === "AbortError",
  );
  assert.equal(fetchCalled, true); // the request was attempted, then aborted — no timeout
});
