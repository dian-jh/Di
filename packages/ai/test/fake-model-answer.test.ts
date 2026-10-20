import test from "node:test";
import assert from "node:assert/strict";

import type {
  ChatModel,
  ModelEvent,
  ModelRequest,
  ModelResponse,
} from "@di/ai";
import { textOfMessage } from "@di/ai";

const EXPECTED_TEXT = "Hello from the fake model.";

/**
 * A fake @di/ai ChatModel that streams a single tool-free answer: one
 * textDelta followed by exactly one completed carrying the assembled response.
 * The completed response is the business payload the loop will consume.
 */
class FakeToolFreeModel implements ChatModel {
  stream(request: ModelRequest, _signal?: AbortSignal): AsyncIterable<ModelEvent> {
    return (async function* (): AsyncGenerator<ModelEvent> {
      yield { type: "textDelta", delta: EXPECTED_TEXT };

      const response: ModelResponse = {
        message: { role: "assistant", content: [{ type: "text", text: EXPECTED_TEXT }] },
        finishReason: { type: "stop" },
        usage: { inputTokens: 5, outputTokens: 7 },
        model: "fake-tool-free",
        timestamp: 1_700_000_000_000,
        durationMs: 12,
      };
      yield { type: "completed", response };
    })();
  }
}

const isTextDelta = (event: ModelEvent): event is Extract<ModelEvent, { type: "textDelta" }> =>
  event.type === "textDelta";
const isCompleted = (event: ModelEvent): event is Extract<ModelEvent, { type: "completed" }> =>
  event.type === "completed";

test("a tool-free fake @di/ai model streams the expected answer then completes", async () => {
  const model = new FakeToolFreeModel();
  const request: ModelRequest = {
    messages: [{ role: "user", content: [{ type: "text", text: "Say hello." }] }],
  };

  const events: ModelEvent[] = [];
  for await (const event of model.stream(request)) {
    events.push(event);
  }

  // Tool-free: exactly one textDelta, then exactly one completed, no tool call.
  assert.deepEqual(
    events.map((e) => e.type),
    ["textDelta", "completed"],
  );

  const textDeltas = events.filter(isTextDelta);
  assert.equal(textDeltas[0]?.delta, EXPECTED_TEXT);

  const completed = events.filter(isCompleted);
  const response = completed[0]?.response;
  assert.ok(response, "expected a completed event carrying a ModelResponse");
  assert.equal(response.finishReason.type, "stop");
  assert.equal(response.message.role, "assistant");
  assert.equal(textOfMessage(response.message), EXPECTED_TEXT);
  assert.equal(response.usage.outputTokens, 7);
});
