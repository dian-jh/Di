import test from "node:test";
import assert from "node:assert/strict";

import type { FinishReason, ModelEvent, ProviderChunk } from "@di/ai";
import {
  SseStreamError,
  createDeepSeekTranslator,
  mapFinishReason,
  mapUsage,
  sseToModelEvents,
} from "@di/ai";

/**
 *
 * `TranslateEvent` seam of `sseToModelEvents` (Di baseline
 *
 * 边界 items 1/4/5): raw SSE data line → ProviderChunk(s), text/reasoning/
 * tool-call fragments, [DONE] terminal, bad-JSON line skipping (never crash),
 * usage cache/reasoning split, finish-reason mapping.
 */

type CompletedEvent = Extract<ModelEvent, { type: "completed" }>;

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

function onlyCompleted(events: readonly ModelEvent[]): CompletedEvent["response"] {
  const completed = events.filter((e): e is CompletedEvent => e.type === "completed");
  assert.equal(completed.length, 1, "expected exactly one completed event");
  const event = completed[0];
  assert.ok(event, "completed event missing");
  return event.response;
}

test("translates text deltas with synthesized block boundaries", () => {
  const t = createDeepSeekTranslator();
  assert.deepEqual(t({ event: "message", data: '{"choices":[{"index":0,"delta":{"content":"Hello"}}]}' }), [
    { type: "blockStart", index: 1, block: { type: "text" } },
    { type: "textDelta", index: 1, delta: "Hello" },
  ]);
  assert.deepEqual(t({ event: "message", data: '{"choices":[{"index":0,"delta":{"content":" world"}}]}' }), [
    { type: "textDelta", index: 1, delta: " world" },
  ]);
  assert.deepEqual(t({ event: "message", data: '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}' }), [
    { type: "blockEnd", index: 1 },
    { type: "finish", reason: { type: "stop" } },
  ]);
});

test("keeps reasoning, text, and tool-call blocks on disjoint indices", () => {
  const t = createDeepSeekTranslator();
  assert.deepEqual(t({ event: "message", data: '{"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}' }), [
    { type: "blockStart", index: 0, block: { type: "reasoning" } },
    { type: "reasoningDelta", index: 0, delta: "think" },
  ]);
  assert.deepEqual(t({ event: "message", data: '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}' }), [
    { type: "blockStart", index: 2, block: { type: "tool-call" } },
    { type: "toolCallDelta", index: 2, id: "c1", name: "search", argumentsDelta: '{"q":' },
  ]);
  assert.deepEqual(t({ event: "message", data: '{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}' }), [
    { type: "blockEnd", index: 0 },
    { type: "blockEnd", index: 2 },
    { type: "finish", reason: { type: "tool-calls" } },
  ]);
});

test("assembles a full reasoning+text+tool-call stream through sseToModelEvents", async () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"Let me think"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"The answer is"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"{\\"q\\":"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"beijing\\""}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const events = await collect(
    sseToModelEvents(streamOf(...sse), { model: "deepseek-flash", translateEvent: createDeepSeekTranslator() }),
  );

  assert.deepEqual(events.map((e) => e.type), [
    "reasoningDelta",
    "textDelta",
    "toolCallDelta",
    "toolCallDelta",
    "toolCallDelta",
    "completed",
  ]);
  const response = onlyCompleted(events);
  assert.deepEqual(response.message.content, [
    { type: "reasoning", text: "Let me think" },
    { type: "text", text: "The answer is" },
    { type: "tool-call", id: "call_1", name: "search", arguments: '{"q":"beijing"}' },
  ]);
  assert.deepEqual(response.finishReason, { type: "tool-calls" });
});

test("treats the [DONE] marker as a no-op terminal", () => {
  const t = createDeepSeekTranslator();
  assert.deepEqual(t({ event: "message", data: "[DONE]" }), []);
});

test("completes normally when the finish chunk is followed by [DONE]", async () => {
  const events = await collect(
    sseToModelEvents(
      streamOf(
        'data: {"choices":[{"index":0,"delta":{"content":"你好"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ),
      { model: "m", translateEvent: createDeepSeekTranslator() },
    ),
  );
  const response = onlyCompleted(events);
  assert.deepEqual(response.message.content, [{ type: "text", text: "你好" }]);
  assert.deepEqual(response.finishReason, { type: "stop" });
});

test("throws a connection error when the stream ends with [DONE] but no terminal finish chunk", async () => {
  await assert.rejects(
    collect(
      sseToModelEvents(
        streamOf('data: {"choices":[{"index":0,"delta":{"content":"orphan"}}]}\n\n', "data: [DONE]\n\n"),
        { model: "m", translateEvent: createDeepSeekTranslator() },
      ),
    ),
    (err) => err instanceof SseStreamError && err.code === "connection",
  );
});

test("skips bad JSON and structurally invalid lines without crashing", async () => {
  const events = await collect(
    sseToModelEvents(
      streamOf(
        "data: this is not json\n\n",
        'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
        "data: 42\n\n",
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ),
      { model: "m", translateEvent: createDeepSeekTranslator() },
    ),
  );
  assert.deepEqual(events.map((e) => e.type), ["textDelta", "completed"]);
  const response = onlyCompleted(events);
  assert.deepEqual(response.message.content, [{ type: "text", text: "Hi" }]);
});

test("maps the real DeepSeek usage chunk to TokenUsage with cache/reasoning split", async () => {
  const usageJson = JSON.stringify({
    id: "65327d35-3b80-4a5e-b81f-207bb098a43e",
    object: "chat.completion.chunk",
    created: 1791525449,
    model: "deepseek-flash",
    choices: [{ index: 0, delta: { content: "", reasoning_content: null }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 3291,
      completion_tokens: 24,
      total_tokens: 3315,
      prompt_tokens_details: { cached_tokens: 3072 },
      completion_tokens_details: { reasoning_tokens: 22 },
      prompt_cache_hit_tokens: 3072,
      prompt_cache_miss_tokens: 219,
    },
  });
  const events = await collect(
    sseToModelEvents(streamOf(`data: ${usageJson}\n\n`, "data: [DONE]\n\n"), {
      model: "deepseek-flash",
      translateEvent: createDeepSeekTranslator(),
    }),
  );
  const response = onlyCompleted(events);
  assert.deepEqual(response.usage, {
    inputTokens: 219,
    outputTokens: 24,
    totalTokens: 3315,
    cacheReadTokens: 3072,
    reasoningTokens: 22,
  });
});

test("mapUsage prefers top-level cache-hit over nested cached_tokens", () => {
  assert.deepEqual(
    mapUsage({
      promptTokens: 1000,
      completionTokens: 5,
      totalTokens: 1005,
      promptCacheHitTokens: 800,
      promptTokensDetails: { cachedTokens: 500 },
    }),
    {
      inputTokens: 200,
      outputTokens: 5,
      totalTokens: 1005,
      cacheReadTokens: 800,
    },
  );
});

test("mapUsage keeps the full prompt as input when no cache fields are reported", () => {
  assert.deepEqual(mapUsage({ promptTokens: 1000, completionTokens: 5 }), {
    inputTokens: 1000,
    outputTokens: 5,
  });
});

test("mapUsage preserves missing total tokens as unknown", () => {
  assert.deepEqual(mapUsage({ promptTokens: 10, completionTokens: 2 }), {
    inputTokens: 10,
    outputTokens: 2,
  });
});

test("maps finish_reason values onto the FinishReason vocabulary", () => {
  const cases: ReadonlyArray<[string, FinishReason]> = [
    ["stop", { type: "stop" }],
    ["tool_calls", { type: "tool-calls" }],
    ["length", { type: "max-tokens" }],
    [
      "insufficient_system_resource",
      { type: "error", failure: { message: "系统推理资源不足，生成被打断。", code: "INSUFFICIENT_SYSTEM_RESOURCE", status: 503 } },
    ],
    ["content_filter", { type: "error", failure: { message: "输出内容因触发过滤策略而被过滤。", code: "CONTENT_FILTERED" } }],
    ["aborted", { type: "aborted", failure: { message: "生成过程被中断。", code: "ABORTED" } }],
    ["mystery_reason", { type: "error", failure: { message: "未知 finish_reason: 'mystery_reason'。", code: "UNKNOWN_FINISH_REASON" } }],
  ];
  for (const [reason, expected] of cases) {
    assert.deepEqual(mapFinishReason(reason), expected, `reason=${reason}`);
  }
});

test("emits a finish chunk with the mapped reason from a chunk's finish_reason", () => {
  const t = createDeepSeekTranslator();
  assert.deepEqual(t({ event: "message", data: '{"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}' }), [
    { type: "finish", reason: { type: "max-tokens" } },
  ]);
});

test("emits a single responseInfo chunk for the first chunk carrying an id", () => {
  const t = createDeepSeekTranslator();
  const first = t({ event: "message", data: '{"id":"resp-1","choices":[{"index":0,"delta":{"content":"Hi"}}]}' });
  assert.deepEqual(first[0], { type: "responseInfo", responseId: "resp-1" });

  const second = t({ event: "message", data: '{"id":"resp-1","choices":[{"index":0,"delta":{"content":" there"}}]}' });
  assert.ok(!second.some((c): c is Extract<ProviderChunk, { type: "responseInfo" }> => c.type === "responseInfo"));
});

test("carries the response id into the completed response end to end", async () => {
  const events = await collect(
    sseToModelEvents(
      streamOf(
        'data: {"id":"resp-9","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ),
      { model: "m", translateEvent: createDeepSeekTranslator() },
    ),
  );
  assert.equal(onlyCompleted(events).responseId, "resp-9");
});
