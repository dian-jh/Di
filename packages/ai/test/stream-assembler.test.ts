import test from "node:test";
import assert from "node:assert/strict";

import type {
  ModelEvent,
  ProviderChunk,
  ProviderStreamAssemblerOptions,
} from "@di/ai";
import { AssemblerError, ProviderStreamAssembler } from "@di/ai";

/**
 * P3 card 1 red list — ProviderChunk → ModelEvent assembler (Di baseline
 * `Core/Llm/ChatAssembler.cs` + `Core/Llm/ChatModelClient.cs`, TS contract in
 * architecture.md §"AI Provider 流与模型事件分层" and models-and-auth.md):
 * chunk splitting/merging, multi-byte splits, tool-call argument fragmentation,
 * missing terminal, invalid sequencing.
 */

type CompletedEvent = Extract<ModelEvent, { type: "completed" }>;

function isTextDelta(event: ModelEvent): event is Extract<ModelEvent, { type: "textDelta" }> {
  return event.type === "textDelta";
}

function isToolCallDelta(event: ModelEvent): event is Extract<ModelEvent, { type: "toolCallDelta" }> {
  return event.type === "toolCallDelta";
}

function lastCompleted(events: readonly ModelEvent[]): CompletedEvent["response"] {
  const completed = events.filter((e): e is CompletedEvent => e.type === "completed");
  assert.equal(completed.length, 1, "expected exactly one completed event");
  const event = completed[0];
  assert.ok(event, "completed event missing");
  return event.response;
}

function textOf(events: readonly ModelEvent[]): string {
  return events.filter(isTextDelta).map((e) => e.delta).join("");
}

function run(
  chunks: readonly ProviderChunk[],
  options: ProviderStreamAssemblerOptions = { model: "probe-model" },
): ModelEvent[] {
  const assembler = new ProviderStreamAssembler(options);
  const events: ModelEvent[] = [];
  for (const chunk of chunks) {
    events.push(...assembler.add(chunk));
  }
  events.push(assembler.finish());
  return events;
}

function isAssemblerError(error: unknown, code: string): boolean {
  return error instanceof AssemblerError && error.code === code;
}

test("merges a logical text block split across many chunks", () => {
  const events = run([
    { type: "blockStart", index: 0, block: { type: "text" } },
    { type: "textDelta", index: 0, delta: "Hello " },
    { type: "textDelta", index: 0, delta: "wor" },
    { type: "textDelta", index: 0, delta: "ld!" },
    { type: "blockEnd", index: 0 },
    { type: "usage", usage: { inputTokens: 3, outputTokens: 5 } },
    { type: "finish", reason: { type: "stop" } },
  ]);

  assert.deepEqual(
    events.map((e) => e.type),
    ["textDelta", "textDelta", "textDelta", "completed"],
  );
  assert.equal(textOf(events), "Hello world!");

  const completed = lastCompleted(events);
  assert.deepEqual(completed.message.content, [{ type: "text", text: "Hello world!" }]);
  assert.deepEqual(completed.finishReason, { type: "stop" });
  assert.deepEqual(completed.usage, { inputTokens: 3, outputTokens: 5 });
  assert.equal(completed.model, "probe-model");
});

test("assembles multiple interleaved blocks by block index", () => {
  const events = run([
    { type: "blockStart", index: 0, block: { type: "reasoning" } },
    { type: "reasoningDelta", index: 0, delta: "think" },
    { type: "blockStart", index: 1, block: { type: "text" } },
    { type: "textDelta", index: 1, delta: "Answer:" },
    { type: "reasoningDelta", index: 0, delta: "ing step" },
    { type: "blockStart", index: 2, block: { type: "tool-call" } },
    { type: "toolCallDelta", index: 2, id: "call-7", name: "get_weather", argumentsDelta: '{"city":' },
    { type: "textDelta", index: 1, delta: " 42" },
    { type: "toolCallDelta", index: 2, argumentsDelta: '"BEI"}' },
    { type: "blockEnd", index: 0 },
    { type: "blockEnd", index: 1 },
    { type: "blockEnd", index: 2 },
    { type: "finish", reason: { type: "tool-calls" } },
  ]);

  assert.deepEqual(events.map((e) => e.type), [
    "reasoningDelta",
    "textDelta",
    "reasoningDelta",
    "toolCallDelta",
    "textDelta",
    "toolCallDelta",
    "completed",
  ]);

  const calls = events.filter(isToolCallDelta);
  assert.deepEqual(calls.map((c) => c.id), ["call-7", "call-7"]);
  assert.deepEqual(calls.map((c) => c.name), ["get_weather", "get_weather"]);
  // ModelEvent.toolCallDelta arguments are cumulative raw JSON (loop-and-state.md).
  assert.deepEqual(calls.map((c) => c.arguments), ['{"city":', '{"city":"BEI"}']);

  const completed = lastCompleted(events);
  assert.deepEqual(completed.message.content, [
    { type: "reasoning", text: "thinking step" },
    { type: "text", text: "Answer: 42" },
    { type: "tool-call", id: "call-7", name: "get_weather", arguments: '{"city":"BEI"}' },
  ]);
  assert.deepEqual(completed.finishReason, { type: "tool-calls" });
});

test("keeps same-kind blocks at different indices separate", () => {
  const events = run([
    { type: "blockStart", index: 0, block: { type: "text" } },
    { type: "textDelta", index: 0, delta: "alpha-" },
    { type: "blockStart", index: 1, block: { type: "text" } },
    { type: "textDelta", index: 1, delta: "beta-" },
    { type: "textDelta", index: 0, delta: "one" },
    { type: "blockEnd", index: 1 },
    { type: "blockEnd", index: 0 },
    { type: "finish", reason: { type: "stop" } },
  ]);

  const completed = lastCompleted(events);
  assert.deepEqual(completed.message.content, [
    { type: "text", text: "alpha-one" },
    { type: "text", text: "beta-" },
  ]);
});

test("reassembles multi-byte text split across chunk boundaries", () => {
  const events = run([
    { type: "blockStart", index: 0, block: { type: "text" } },
    { type: "textDelta", index: 0, delta: "\uD83D" }, // first half of the 😀 surrogate pair
    { type: "textDelta", index: 0, delta: "\uDE00" }, // second half
    { type: "textDelta", index: 0, delta: "你好" },
    { type: "blockEnd", index: 0 },
    { type: "finish", reason: { type: "stop" } },
  ]);

  assert.equal(textOf(events), "😀你好");
  const completed = lastCompleted(events);
  assert.deepEqual(completed.message.content, [{ type: "text", text: "😀你好" }]);
});

test("reassembles multi-byte reasoning split across chunk boundaries", () => {
  const events = run([
    { type: "blockStart", index: 0, block: { type: "reasoning" } },
    { type: "reasoningDelta", index: 0, delta: "思考" },
    { type: "reasoningDelta", index: 0, delta: "\uD83D" },
    { type: "reasoningDelta", index: 0, delta: "\uDE00" },
    { type: "blockEnd", index: 0 },
    { type: "finish", reason: { type: "stop" } },
  ]);

  const completed = lastCompleted(events);
  assert.deepEqual(completed.message.content, [{ type: "reasoning", text: "思考😀" }]);
});

test("accumulates tool-call arguments fragmented across many chunks", () => {
  const events = run([
    { type: "blockStart", index: 0, block: { type: "tool-call" } },
    { type: "toolCallDelta", index: 0, id: "tool-1", name: "search", argumentsDelta: '{"q"' },
    { type: "toolCallDelta", index: 0, argumentsDelta: ':"ty' },
    { type: "toolCallDelta", index: 0, argumentsDelta: "ping" },
    { type: "toolCallDelta", index: 0, argumentsDelta: '"}' },
    { type: "blockEnd", index: 0 },
    { type: "finish", reason: { type: "tool-calls" } },
  ]);

  const calls = events.filter(isToolCallDelta);
  assert.deepEqual(calls.map((c) => c.arguments), ['{"q"', '{"q":"ty', '{"q":"typing', '{"q":"typing"}']);

  const completed = lastCompleted(events);
  assert.deepEqual(completed.message.content, [
    { type: "tool-call", id: "tool-1", name: "search", arguments: '{"q":"typing"}' },
  ]);
});

test("does not cross-contaminate interleaved tool-call argument buffers", () => {
  const events = run([
    { type: "blockStart", index: 0, block: { type: "tool-call" } },
    { type: "toolCallDelta", index: 0, id: "a", name: "tool_a", argumentsDelta: '{"x":' },
    { type: "blockStart", index: 1, block: { type: "tool-call" } },
    { type: "toolCallDelta", index: 1, id: "b", name: "tool_b", argumentsDelta: '{"y":' },
    { type: "toolCallDelta", index: 0, argumentsDelta: "1}" },
    { type: "toolCallDelta", index: 1, argumentsDelta: "2}" },
    { type: "blockEnd", index: 0 },
    { type: "blockEnd", index: 1 },
    { type: "finish", reason: { type: "tool-calls" } },
  ]);

  const completed = lastCompleted(events);
  assert.deepEqual(completed.message.content, [
    { type: "tool-call", id: "a", name: "tool_a", arguments: '{"x":1}' },
    { type: "tool-call", id: "b", name: "tool_b", arguments: '{"y":2}' },
  ]);
});

test("fills in tool-call id and name when they arrive on later deltas", () => {
  const events = run([
    { type: "blockStart", index: 0, block: { type: "tool-call" } },
    { type: "toolCallDelta", index: 0, argumentsDelta: "{}" },
    { type: "toolCallDelta", index: 0, id: "late-id", name: "late_name", argumentsDelta: "" },
    { type: "blockEnd", index: 0 },
    { type: "finish", reason: { type: "tool-calls" } },
  ]);

  const calls = events.filter(isToolCallDelta);
  assert.deepEqual(calls[0], { type: "toolCallDelta", id: "call_0", name: "", arguments: "{}" });
  assert.deepEqual(calls[1], { type: "toolCallDelta", id: "late-id", name: "late_name", arguments: "{}" });

  const completed = lastCompleted(events);
  assert.deepEqual(completed.message.content, [
    { type: "tool-call", id: "late-id", name: "late_name", arguments: "{}" },
  ]);
});

test("applies C# defaults for tool calls missing id, name, and arguments", () => {
  const events = run([
    { type: "blockStart", index: 0, block: { type: "tool-call" } },
    { type: "toolCallDelta", index: 0, name: "only_name", argumentsDelta: "" },
    { type: "blockEnd", index: 0 },
    { type: "finish", reason: { type: "tool-calls" } },
  ]);

  const completed = lastCompleted(events);
  assert.deepEqual(completed.message.content, [
    { type: "tool-call", id: "call_0", name: "only_name", arguments: "{}" },
  ]);
});

test("throws missing-finish when the stream ends without a finish chunk", () => {
  const assembler = new ProviderStreamAssembler({ model: "probe" });
  assembler.add({ type: "blockStart", index: 0, block: { type: "text" } });
  assembler.add({ type: "textDelta", index: 0, delta: "partial" });
  assembler.add({ type: "blockEnd", index: 0 });
  // no finish chunk — nothing must be fabricated
  assert.throws(() => assembler.finish(), (err) => isAssemblerError(err, "missing-finish"));
});

test("throws missing-finish when the stream ends with a block still open and no finish", () => {
  const assembler = new ProviderStreamAssembler({ model: "probe" });
  assembler.add({ type: "blockStart", index: 0, block: { type: "text" } });
  assert.throws(() => assembler.finish(), (err) => isAssemblerError(err, "missing-finish"));
});

test("throws unclosed-block when finish arrives with a block still open", () => {
  const assembler = new ProviderStreamAssembler({ model: "probe" });
  assembler.add({ type: "blockStart", index: 0, block: { type: "text" } });
  assembler.add({ type: "textDelta", index: 0, delta: "never closed" });
  assert.throws(
    () => assembler.add({ type: "finish", reason: { type: "stop" } }),
    (err) => isAssemblerError(err, "unclosed-block"),
  );
});

test("rejects duplicate blockStart for the same index", () => {
  const assembler = new ProviderStreamAssembler({ model: "probe" });
  assembler.add({ type: "blockStart", index: 0, block: { type: "text" } });
  assert.throws(
    () => assembler.add({ type: "blockStart", index: 0, block: { type: "text" } }),
    (err) => isAssemblerError(err, "duplicate-block-start"),
  );
});

test("rejects a delta for an index that never started", () => {
  const assembler = new ProviderStreamAssembler({ model: "probe" });
  assert.throws(
    () => assembler.add({ type: "textDelta", index: 3, delta: "x" }),
    (err) => isAssemblerError(err, "delta-without-block"),
  );
});

test("rejects a delta for a block already closed", () => {
  const assembler = new ProviderStreamAssembler({ model: "probe" });
  assembler.add({ type: "blockStart", index: 0, block: { type: "text" } });
  assembler.add({ type: "textDelta", index: 0, delta: "done" });
  assembler.add({ type: "blockEnd", index: 0 });
  assert.throws(
    () => assembler.add({ type: "textDelta", index: 0, delta: "after" }),
    (err) => isAssemblerError(err, "delta-without-block"),
  );
});

test("rejects a delta that does not match the open block kind", () => {
  const assembler = new ProviderStreamAssembler({ model: "probe" });
  assembler.add({ type: "blockStart", index: 0, block: { type: "tool-call" } });
  assert.throws(
    () => assembler.add({ type: "textDelta", index: 0, delta: "x" }),
    (err) => isAssemblerError(err, "delta-type-mismatch"),
  );
});

test("rejects blockEnd for an index that never started", () => {
  const assembler = new ProviderStreamAssembler({ model: "probe" });
  assert.throws(
    () => assembler.add({ type: "blockEnd", index: 9 }),
    (err) => isAssemblerError(err, "block-end-without-start"),
  );
});

test("rejects any chunk after a finish chunk", () => {
  const assembler = new ProviderStreamAssembler({ model: "probe" });
  assembler.add({ type: "finish", reason: { type: "stop" } });
  assert.throws(
    () => assembler.add({ type: "textDelta", index: 0, delta: "late" }),
    (err) => isAssemblerError(err, "chunk-after-finish"),
  );
  assert.throws(
    () => assembler.add({ type: "usage", usage: { inputTokens: 0, outputTokens: 0 } }),
    (err) => isAssemblerError(err, "chunk-after-finish"),
  );
  assert.throws(
    () => assembler.add({ type: "finish", reason: { type: "stop" } }),
    (err) => isAssemblerError(err, "chunk-after-finish"),
  );
});

test("carries an in-band error finish reason on completed without fabricating success", () => {
  const failure = { message: "upstream failed", code: "upstream_error", status: 502 };
  const events = run([
    { type: "blockStart", index: 0, block: { type: "text" } },
    { type: "textDelta", index: 0, delta: "partial answer" },
    { type: "blockEnd", index: 0 },
    { type: "finish", reason: { type: "error", failure } },
  ]);

  const completed = lastCompleted(events);
  assert.deepEqual(completed.finishReason, { type: "error", failure });
  assert.deepEqual(completed.message.content, [{ type: "text", text: "partial answer" }]);
});

test("carries an aborted finish reason on completed", () => {
  const failure = { message: "cancelled", code: "aborted" };
  const events = run([{ type: "finish", reason: { type: "aborted", failure } }]);

  const completed = lastCompleted(events);
  assert.deepEqual(completed.finishReason, { type: "aborted", failure });
  assert.deepEqual(completed.message.content, []);
});

test("defaults usage to zero when no usage chunk arrives", () => {
  const events = run([{ type: "finish", reason: { type: "stop" } }]);

  const completed = lastCompleted(events);
  assert.deepEqual(completed.usage, { inputTokens: 0, outputTokens: 0 });
});

test("carries the response id from the responseInfo chunk", () => {
  const events = run([
    { type: "responseInfo", responseId: "resp-abc" },
    { type: "finish", reason: { type: "stop" } },
  ]);

  assert.equal(lastCompleted(events).responseId, "resp-abc");
});

test("emits completed with an empty assistant message when no blocks were produced", () => {
  const events = run([
    { type: "usage", usage: { inputTokens: 10, outputTokens: 0 } },
    { type: "finish", reason: { type: "max-tokens" } },
  ]);

  assert.deepEqual(events.map((e) => e.type), ["completed"]);
  const completed = lastCompleted(events);
  assert.equal(completed.message.role, "assistant");
  assert.deepEqual(completed.message.content, []);
  assert.deepEqual(completed.finishReason, { type: "max-tokens" });
  assert.deepEqual(completed.usage, { inputTokens: 10, outputTokens: 0 });
});

test("preserves an opaque block losslessly", () => {
  const events = run([
    { type: "blockStart", index: 0, block: { type: "opaque", blockType: "plugin-note", rawJson: '{"k":"v"}' } },
    { type: "blockEnd", index: 0 },
    { type: "finish", reason: { type: "stop" } },
  ]);

  const completed = lastCompleted(events);
  assert.deepEqual(completed.message.content, [{ type: "plugin-note", rawJson: '{"k":"v"}' }]);
});

test("carries model id, timestamp, and monotonic duration on the completed response", () => {
  const events = run([{ type: "finish", reason: { type: "stop" } }], {
    model: "model-x",
    timestamp: 1_700_000_000_123,
  });

  const completed = lastCompleted(events);
  assert.equal(completed.model, "model-x");
  assert.equal(completed.timestamp, 1_700_000_000_123);
  assert.ok(typeof completed.durationMs === "number");
  assert.ok(completed.durationMs >= 0);
  // cost computation is a later P3 card; it must not be fabricated here.
  assert.equal(completed.cost, undefined);
});

test("rejects a second finish() call", () => {
  const assembler = new ProviderStreamAssembler({ model: "probe" });
  assembler.add({ type: "finish", reason: { type: "stop" } });
  assembler.finish();
  assert.throws(() => assembler.finish(), (err) => isAssemblerError(err, "already-completed"));
});
