import test from "node:test";
import assert from "node:assert/strict";

import type { ModelEvent, ModelRequest } from "@di/ai";
import { DeepSeekAdapter, DeepSeekError, mapHttpErrorBody } from "@di/ai";

/**
 * P3 card 3 red list — DeepSeek HTTP/SSE adapter and non-2xx error mapping
 * (Di baseline `Core/Providers/DeepSeek/DeepSeekAdapter.cs` `SendAsync` +
 * `ParseDeepSeekError` + `MapErrorCode`; models-and-auth.md §DeepSeek 协议边界
 * item 4). Retry/backoff and header-wait timeout are later card P3.5 — no retry
 * loops here, only the structured non-2xx body → LlmFailure mapping and the
 * stream plumbing through the `TranslateEvent` seam.
 */

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

async function collect<T>(iterable: AsyncIterable<T>): Promise<readonly T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const request: ModelRequest = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };

test("streams a 200 SSE response through to a completed ModelEvent", async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(
      streamOf(
        'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const adapter = new DeepSeekAdapter({ model: "deepseek-flash", apiKey: "test-key", fetch: fetchImpl });

  const events = await collect(adapter.stream(request));
  assert.deepEqual(events.map((e) => e.type), ["textDelta", "completed"]);
  const completed = events.find((e): e is Extract<ModelEvent, { type: "completed" }> => e.type === "completed");
  assert.ok(completed, "expected a completed event");
  assert.deepEqual(completed.response.message.content, [{ type: "text", text: "Hello" }]);
  assert.deepEqual(completed.response.finishReason, { type: "stop" });
  assert.equal(completed.response.model, "deepseek-flash");
});

test("maps a 429 error body with retry-after to a structured DeepSeekError", async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(
      '{"error":{"message":"Rate limit exceeded","type":"rate_limit_exceeded","code":"rate_limit"}}',
      { status: 429, headers: { "retry-after": "5" } },
    );
  const adapter = new DeepSeekAdapter({ model: "deepseek-flash", apiKey: "test-key", fetch: fetchImpl });

  await assert.rejects(
    collect(adapter.stream(request)),
    (err) =>
      err instanceof DeepSeekError &&
      err.code === "RATE_LIMITED" &&
      err.status === 429 &&
      err.providerRetryAfterMs === 5000 &&
      err.failure.message === "Rate limit exceeded",
  );
});

test("maps 401 and 403 to MISSING_CREDENTIAL", async () => {
  for (const status of [401, 403]) {
    const fetchImpl = async (): Promise<Response> =>
      new Response('{"error":{"message":"Invalid API key"}}', { status });
    const adapter = new DeepSeekAdapter({ model: "m", apiKey: "test-key", fetch: fetchImpl });

    await assert.rejects(
      collect(adapter.stream(request)),
      (err) => err instanceof DeepSeekError && err.code === "MISSING_CREDENTIAL" && err.status === status,
    );
  }
});

test("rejects a missing API key before any request", async () => {
  let called = false;
  const adapter = new DeepSeekAdapter({
    model: "m",
    apiKey: "",
    fetch: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });

  await assert.rejects(
    collect(adapter.stream(request)),
    (err) => err instanceof DeepSeekError && err.code === "MISSING_CREDENTIAL",
  );
  assert.equal(called, false);
});

test("mapHttpErrorBody extracts error.message/type/code from the JSON body", () => {
  assert.deepEqual(
    mapHttpErrorBody(400, '{"error":{"message":"bad request","type":"invalid_request_error","code":"invalid_request_error"}}'),
    { message: "bad request", code: "invalid_request_error", status: 400 },
  );
});

test("mapHttpErrorBody falls back to status-derived codes and raw body text", () => {
  assert.deepEqual(mapHttpErrorBody(502, "upstream exploded"), {
    message: "upstream exploded",
    code: "INVALID_REQUEST",
    status: 502,
  });
  assert.deepEqual(mapHttpErrorBody(500, ""), { message: "500", code: "INVALID_REQUEST", status: 500 });
  assert.deepEqual(mapHttpErrorBody(429, "", 2500), {
    message: "429",
    code: "RATE_LIMITED",
    status: 429,
    providerRetryAfterMs: 2500,
  });
});

test("mapHttpErrorBody uses body.type when message is absent", () => {
  assert.deepEqual(mapHttpErrorBody(503, '{"error":{"type":"server_error"}}'), {
    message: "server_error",
    code: "server_error",
    status: 503,
  });
});
