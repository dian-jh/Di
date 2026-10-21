import test from "node:test";
import assert from "node:assert/strict";

import type { ModelEvent, ModelRequest, TokenUsage } from "@di/ai";
import { DeepSeekAdapter, costForModel } from "@di/ai";

/**
 * P3.4 cost wiring red list — the DeepSeek adapter must forward the stream usage
 * to `costForModel("deepseek", model, usage)` so production `ModelResponse.cost`
 * is real (Di baseline `LlmRuntime.CalculateCost` + models-and-auth.md
 * §Token 与缓存计量). A catalog model with rates gets a computed cost; an
 * unknown model keeps `cost` absent — never a fabricated zero.
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

function onlyCompleted(events: readonly ModelEvent[]): Extract<ModelEvent, { type: "completed" }> {
  const completed = events.find((e): e is Extract<ModelEvent, { type: "completed" }> => e.type === "completed");
  assert.ok(completed, "expected a completed event");
  return completed;
}

const request: ModelRequest = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };

test("attaches a real cost for a catalog model with rates (deepseek-flash)", async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(
      streamOf(
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
        'data: {"id":"c1","usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500,"prompt_cache_hit_tokens":400}}\n\n',
        'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const adapter = new DeepSeekAdapter({ model: "deepseek-flash", apiKey: "test-key", fetch: fetchImpl });

  const events = await collect(adapter.stream(request));
  const completed = onlyCompleted(events);

  // usage aggregation path is unchanged: token counts come from the stream usage event.
  const expectedUsage: TokenUsage = {
    inputTokens: 600, // prompt_cache_miss: 1000 - 400 cache hit
    outputTokens: 500,
    totalTokens: 1500,
    cacheReadTokens: 400,
  };
  assert.deepEqual(completed.response.usage, expectedUsage);

  // cost must equal the costForModel result for the aggregated usage (never undefined).
  const expectedCost = costForModel("deepseek", "deepseek-flash", expectedUsage);
  assert.ok(expectedCost, "deepseek-flash has catalog rates — cost must be computed");
  assert.deepEqual(completed.response.cost, expectedCost);
  assert.deepEqual(completed.response.cost, {
    input: (0.28 * 600) / 1_000_000,
    output: (0.42 * 500) / 1_000_000,
    cacheRead: (0.07 * 400) / 1_000_000,
    cacheWrite: 0,
  });
});

test("keeps cost absent for an unknown model (never fabricates a zero)", async () => {
  const fetchImpl = async (): Promise<Response> =>
    new Response(
      streamOf(
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
        'data: {"id":"c1","usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500,"prompt_cache_hit_tokens":400}}\n\n',
        'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const adapter = new DeepSeekAdapter({ model: "deepseek-unknown", apiKey: "test-key", fetch: fetchImpl });

  const events = await collect(adapter.stream(request));
  const completed = onlyCompleted(events);

  assert.equal("cost" in completed.response, false);
  assert.equal(completed.response.cost, undefined);
});
