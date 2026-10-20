import test from "node:test";
import assert from "node:assert/strict";

import type { FinishReason, ModelEvent, ModelRequest, TokenUsage } from "@di/ai";
import { ChatGptAdapter, ChatGptError, SseStreamError } from "@di/ai";

/**
 * P8a card red list — ChatGPT Responses HTTP/SSE adapter (Di baseline
 * `Core/Providers/ChatGpt/ChatGptAdapter.cs` `StreamAsync` + `SendAsync`;
 * models-and-auth.md §"Responses wire 与 SSE"): each Responses SSE delta kind,
 * provider-terminal semantics (completed/failed/incomplete kept distinct, never
 * collapsed to a success stop), protocol truncation vs TCP EOF, per-field usage
 * cache normalization (never blanket zero-fill nullable fields), raw output
 * preservation, non-2xx status/body/request-id/Retry-After, mid-stream breaks
 * and caller cancellation. All tests use injected fetch — no real API/credentials.
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

type CompletedEvent = Extract<ModelEvent, { type: "completed" }>;

function onlyCompleted(events: readonly ModelEvent[]): CompletedEvent["response"] {
  const completed = events.filter((e): e is CompletedEvent => e.type === "completed");
  assert.equal(completed.length, 1, "expected exactly one completed event");
  const event = completed[0];
  assert.ok(event, "completed event missing");
  return event.response;
}

const request: ModelRequest = { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] };

function sse(...events: readonly string[]): string {
  return events.map((e) => `data: ${e}\n\n`).join("");
}

test("streams reasoning, text, and tool-call deltas through to a completed ModelEvent", async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(
      streamOf(
        sse(
          '{"type":"response.created","response":{"id":"resp_test"}}',
          '{"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"Think"}',
          '{"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_test","summary":[],"encrypted_content":"opaque"}}',
          '{"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"Working"}',
          '{"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","call_id":"call_1","namespace":"di","name":"shell","arguments":""}}',
          '{"type":"response.function_call_arguments.delta","output_index":2,"delta":"{\\"cmd\\":"}',
          '{"type":"response.function_call_arguments.delta","output_index":2,"delta":"\\"pwd\\"}"}',
          '{"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120,"input_tokens_details":{"cached_tokens":60},"output_tokens_details":{"reasoning_tokens":10}}}}',
        ),
      ),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const adapter = new ChatGptAdapter({ model: "gpt-6.1-sol", apiKey: "test-token", fetch: fetchImpl });

  const events = await collect(adapter.stream(request));
  assert.deepEqual(events.map((e) => e.type), [
    "reasoningDelta",
    "textDelta",
    "toolCallDelta",
    "toolCallDelta",
    "toolCallDelta",
    "completed",
  ]);
  const response = onlyCompleted(events);
  assert.equal(response.responseId, "resp_test");
  assert.deepEqual(response.message.content, [
    { type: "reasoning", text: "Think" },
    { type: "text", text: "Working" },
    { type: "tool-call", id: "call_1", name: "shell", arguments: '{"cmd":"pwd"}' },
    {
      type: "chatgpt.reasoning",
      rawJson: JSON.stringify({ type: "reasoning", id: "rs_test", summary: [], encrypted_content: "opaque" }),
    },
  ]);
  assert.deepEqual(response.finishReason, { type: "tool-calls" });
  assert.deepEqual(response.usage, {
    inputTokens: 40,
    outputTokens: 20,
    totalTokens: 120,
    cacheReadTokens: 60,
    reasoningTokens: 10,
  });
});

test("treats response.refusal.delta as text output", async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(
      streamOf(
        sse(
          '{"type":"response.refusal.delta","delta":"I cannot help with that."}',
          '{"type":"response.completed","response":{}}',
        ),
      ),
      { status: 200 },
    );
  const adapter = new ChatGptAdapter({ model: "m", apiKey: "k", fetch: fetchImpl });
  const response = onlyCompleted(await collect(adapter.stream(request)));
  assert.deepEqual(response.message.content, [{ type: "text", text: "I cannot help with that." }]);
});

test("maps completed/failed/incomplete terminals to their own finish semantics", async () => {
  const cases: Array<{ name: string; terminal: string; expected: FinishReason }> = [
    {
      name: "completed without tools",
      terminal: '{"type":"response.completed","response":{}}',
      expected: { type: "stop" },
    },
    {
      name: "completed with tools",
      terminal: '{"type":"response.completed","response":{}}',
      expected: { type: "tool-calls" },
    },
    {
      name: "failed",
      terminal:
        '{"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"failure"}}}',
      expected: {
        type: "error",
        failure: { message: "failure", code: "subscription_sharing_usage_limit_exceeded" },
      },
    },
    {
      name: "incomplete max_output_tokens",
      terminal: '{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}',
      expected: { type: "max-tokens" },
    },
    {
      name: "incomplete content_filter",
      terminal: '{"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}',
      expected: { type: "error", failure: { message: '{"reason":"content_filter"}', code: "content_filter" } },
    },
    {
      name: "error event",
      terminal: '{"type":"error","code":"server_error","message":"server exploded"}',
      expected: { type: "error", failure: { message: "server exploded", code: "server_error" } },
    },
  ];
  for (const c of cases) {
    const withTools: ModelRequest = c.name === "completed with tools"
      ? {
          messages: [
            { role: "user", content: [{ type: "text", text: "hi" }] },
            {
              role: "assistant",
              content: [{ type: "tool-call", id: "call_1", name: "shell", arguments: "{}" }],
            },
          ],
        }
      : request;
    // A stream that only sees the terminal never emits a tool call, so the
    // "completed with tools" case needs a function_call event too.
    const events = c.name === "completed with tools"
      ? [
          '{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_1","namespace":"di","name":"shell","arguments":""}}',
          c.terminal,
        ]
      : [c.terminal];
    const fetchImpl = async (): Promise<Response> =>
      new Response(streamOf(sse(...events)), { status: 200 });
    const adapter = new ChatGptAdapter({ model: "m", apiKey: "k", fetch: fetchImpl });
    const response = onlyCompleted(await collect(adapter.stream(withTools)));
    assert.deepEqual(response.finishReason, c.expected, `case=${c.name}`);
  }
});

test("throws a connection error when the SSE stream ends without a terminal event", async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(streamOf(sse('{"type":"response.output_text.delta","delta":"partial"}')), { status: 200 });
  const adapter = new ChatGptAdapter({ model: "m", apiKey: "k", fetch: fetchImpl });
  await assert.rejects(
    collect(adapter.stream(request)),
    (err) => err instanceof SseStreamError && err.code === "connection",
  );
});

test("treats [DONE] without a terminal event as a protocol truncation, never a success", async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(
      streamOf(sse('{"type":"response.output_text.delta","delta":"partial"}', "[DONE]")),
      { status: 200 },
    );
  const adapter = new ChatGptAdapter({ model: "m", apiKey: "k", fetch: fetchImpl });
  await assert.rejects(
    collect(adapter.stream(request)),
    (err) => err instanceof SseStreamError && err.code === "connection",
  );
});

test("normalizes usage cache fields per-field and never zero-fills nullable fields", async () => {
  const cases: Array<{ name: string; usage: string; expected: TokenUsage }> = [
    {
      name: "cached and cache-write reported",
      usage:
        '{"input_tokens":3000,"output_tokens":50,"total_tokens":3050,"input_tokens_details":{"cached_tokens":1000,"cache_write_tokens":1500}}',
      expected: { inputTokens: 500, outputTokens: 50, totalTokens: 3050, cacheReadTokens: 1000, cacheWriteTokens: 1500 },
    },
    {
      name: "no cache details",
      usage: '{"input_tokens":100,"output_tokens":20}',
      expected: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 },
    },
    {
      name: "missing input_tokens",
      usage: '{"output_tokens":5,"total_tokens":5}',
      expected: { inputTokens: 0, outputTokens: 5, totalTokens: 5, cacheReadTokens: 0 },
    },
  ];
  for (const c of cases) {
    const fetchImpl = async (): Promise<Response> =>
      new Response(streamOf(sse(`{"type":"response.completed","response":{"usage":${c.usage}}}`)), { status: 200 });
    const adapter = new ChatGptAdapter({ model: "m", apiKey: "k", fetch: fetchImpl });
    const response = onlyCompleted(await collect(adapter.stream(request)));
    assert.deepEqual(response.usage, c.expected, `case=${c.name}`);
  }
});

test("preserves original response.output as an opaque block when the terminal carries it", async () => {
  const output = [
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "first", annotations: [] }],
    },
  ];
  const fetchImpl = async (): Promise<Response> =>
    new Response(streamOf(sse(`{"type":"response.completed","response":{"output":${JSON.stringify(output)}}}`)), {
      status: 200,
    });
  const adapter = new ChatGptAdapter({ model: "m", apiKey: "k", fetch: fetchImpl });
  const response = onlyCompleted(await collect(adapter.stream(request)));
  assert.deepEqual(response.message.content, [{ type: "chatgpt.output", rawJson: JSON.stringify(output) }]);
  const rawJson = (response.message.content[0] as { rawJson: string }).rawJson;
  assert.deepEqual(JSON.parse(rawJson), output);
});

test("preserves status, body, request id and retry-after on a non-2xx admission error", async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response('{"detail":"region restriction"}', {
      status: 403,
      headers: { "x-request-id": "req_123", "retry-after": "2" },
    });
  const adapter = new ChatGptAdapter({ model: "m", apiKey: "k", fetch: fetchImpl });
  await assert.rejects(
    collect(adapter.stream(request)),
    (err) =>
      err instanceof ChatGptError &&
      err.status === 403 &&
      err.code === "INVALID_REQUEST" &&
      err.failure.requestId === "req_123" &&
      err.failure.providerRetryAfterMs === 2000 &&
      err.failure.message.includes("req_123") &&
      err.failure.message.includes("region restriction"),
  );
});

test("rejects a missing API key before any request", async () => {
  let called = false;
  const adapter = new ChatGptAdapter({
    model: "m",
    apiKey: "",
    fetch: async () => {
      called = true;
      throw new Error("must not be called");
    },
  });
  await assert.rejects(
    collect(adapter.stream(request)),
    (err) => err instanceof ChatGptError && err.code === "MISSING_CREDENTIAL",
  );
  assert.equal(called, false);
});

test("maps a mid-stream connection break to a structured connection error", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
      controller.error(new Error("socket reset"));
    },
  });
  const fetchImpl = async (): Promise<Response> => new Response(stream, { status: 200 });
  const adapter = new ChatGptAdapter({ model: "m", apiKey: "k", fetch: fetchImpl });
  await assert.rejects(
    collect(adapter.stream(request)),
    (err) => err instanceof SseStreamError && err.code === "connection",
  );
});

test("caller cancellation ends reading immediately with an aborted error and never retries", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
    },
  });
  const fetchImpl = async (): Promise<Response> => new Response(stream, { status: 200 });
  const adapter = new ChatGptAdapter({ model: "m", apiKey: "k", fetch: fetchImpl });
  const controller = new AbortController();
  const rejection = collect(adapter.stream(request, controller.signal));
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(rejection, (err) => err instanceof SseStreamError && err.code === "aborted");
});

test("hashes the session id into a stable prompt_cache_key", async () => {
  let lastBody: string | undefined;
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    lastBody = init?.body as string;
    return new Response(streamOf(sse('{"type":"response.completed","response":{}}')), { status: 200 });
  };
  const adapter = new ChatGptAdapter({ model: "m", apiKey: "k", fetch: fetchImpl });
  const withSession: ModelRequest = { ...request, sessionId: "a-session" };

  await collect(adapter.stream(withSession));
  const key = (JSON.parse(lastBody ?? "{}") as { prompt_cache_key?: string }).prompt_cache_key;
  assert.match(key ?? "", /^[0-9a-f]{64}$/);
  // Same session → same key; a different session → a different key.
  await collect(adapter.stream({ ...withSession, messages: [{ role: "user", content: [{ type: "text", text: "next" }] }] }));
  assert.equal((JSON.parse(lastBody ?? "{}") as { prompt_cache_key?: string }).prompt_cache_key, key);
  await collect(adapter.stream({ ...request, sessionId: "other-session" }));
  assert.notEqual((JSON.parse(lastBody ?? "{}") as { prompt_cache_key?: string }).prompt_cache_key, key);
  // No session id → no prompt_cache_key on the wire.
  await collect(adapter.stream(request));
  assert.equal((JSON.parse(lastBody ?? "{}") as { prompt_cache_key?: string }).prompt_cache_key, undefined);
});
