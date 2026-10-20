import test from "node:test";
import assert from "node:assert/strict";

import {
  nowUtcIso,
  parseCheckpointBlock,
  parseCheckpointMessage,
  serializeCheckpointBlock,
  serializeCheckpointMessage,
  serializeEnvelope,
} from "@di/coding-agent";

/**
 * P5 checkpoint envelope + message/block codec
 * (docs/migration/typescript-core/sessions-and-compatibility.md §"Di 文件布局与
 * 逐行 envelope" / §"实时 checkpoint record 与完整示例"; C# baseline
 * `Core/Sessions/SessionLog.cs` `Append` / `SerializeCheckpointMessage` /
 * `SerializeCheckpointBlock`).
 *
 * The writer must emit a stable `{timestamp, ordinal, type, payload}` envelope
 * (null omitted, snake_case, raw UTF-8), map the in-memory `tool-call` block to
 * the wire `tool_call`, and REJECT any block it cannot serialize (never the
 * C#-baseline `{type:"unknown"}` asymmetry). The reader must round-trip the
 * whitelisted block set and reject unknown roles/blocks with line numbers.
 */

test("envelope serializes with stable key order, ordinal and raw UTF-8", () => {
  const line = serializeEnvelope("checkpoint_turn_started", { call_id: "c1", 名称: "读写" }, 7, "2026-10-19T03:04:05.006Z");
  assert.equal(
    line,
    '{"timestamp":"2026-10-19T03:04:05.006Z","ordinal":7,"type":"checkpoint_turn_started","payload":{"call_id":"c1","名称":"读写"}}',
  );
  // raw UTF-8: the Chinese characters are written literally, never \uXXXX.
  assert.ok(!line.includes("\\u"));
});

test("nowUtcIso emits the C#-style UTC millisecond timestamp with Z", () => {
  const value = nowUtcIso();
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // UTC, not local time: a fresh Date is within a few seconds of the string.
  assert.ok(Math.abs(Date.parse(value) - Date.now()) < 10_000);
});

test("serializeCheckpointMessage maps all four roles to snake_case wire shapes", () => {
  assert.deepEqual(serializeCheckpointMessage({ role: "system", text: "规则" }), { role: "system", text: "规则" });
  assert.deepEqual(
    serializeCheckpointMessage({ role: "user", content: [{ type: "text", text: "你好" }] }),
    { role: "user", blocks: [{ type: "text", text: "你好" }] },
  );
  assert.deepEqual(
    serializeCheckpointMessage({
      role: "assistant",
      content: [
        { type: "reasoning", text: "想" },
        { type: "tool-call", id: "call-01", name: "read_file", arguments: '{"path":"build.log"}' },
      ],
    }),
    {
      role: "assistant",
      blocks: [
        { type: "reasoning", text: "想" },
        { type: "tool_call", id: "call-01", name: "read_file", arguments: '{"path":"build.log"}' },
      ],
    },
  );
  assert.deepEqual(
    serializeCheckpointMessage({ role: "tool", toolCallId: "call-01", content: "error CS1002", isError: false }),
    { role: "tool", call_id: "call-01", text: "error CS1002", is_error: false },
  );
});

test("serializeCheckpointBlock maps whitelisted blocks and omits null optionals", () => {
  assert.deepEqual(serializeCheckpointBlock({ type: "text", text: "x" }), { type: "text", text: "x" });
  assert.deepEqual(serializeCheckpointBlock({ type: "reasoning", text: "y" }), { type: "reasoning", text: "y" });
  assert.deepEqual(
    serializeCheckpointBlock({ type: "image", attachmentId: "att-1" }),
    { type: "image", attachment_id: "att-1" },
  );
  assert.deepEqual(
    serializeCheckpointBlock({ type: "image", attachmentId: "att-1", detail: "high" }),
    { type: "image", attachment_id: "att-1", detail: "high" },
  );
  assert.deepEqual(
    serializeCheckpointBlock({ type: "file", attachmentId: "att-2" }),
    { type: "file", attachment_id: "att-2" },
  );
  assert.deepEqual(
    serializeCheckpointBlock({ type: "file", attachmentId: "att-2", filename: "a.txt" }),
    { type: "file", attachment_id: "att-2", filename: "a.txt" },
  );
  assert.deepEqual(
    serializeCheckpointBlock({ type: "custom_block", rawJson: '{"x":1}' }),
    { type: "opaque", unknown_type: "custom_block", raw_json: '{"x":1}' },
  );
});

test("serializeCheckpointBlock rejects un-serializable blocks (never writes {type:unknown})", () => {
  assert.throws(
    () => serializeCheckpointBlock({ type: "tool-result", toolCallId: "c", content: "r", isError: false }),
    (error: unknown) => error instanceof Error && /Unsupported checkpoint block type: tool-result/.test(error.message),
  );
});

test("parseCheckpointMessage round-trips messages and rejects unknown roles", () => {
  const wire = {
    role: "assistant",
    blocks: [
      { type: "reasoning", text: "想" },
      { type: "tool_call", id: "call-01", name: "read_file", arguments: '{"path":"build.log"}' },
    ],
  };
  assert.deepEqual(parseCheckpointMessage(wire, 3), {
    role: "assistant",
    content: [
      { type: "reasoning", text: "想" },
      { type: "tool-call", id: "call-01", name: "read_file", arguments: '{"path":"build.log"}' },
    ],
  });
  assert.deepEqual(parseCheckpointMessage({ role: "tool", call_id: "c1", text: "r", is_error: true }, 4), {
    role: "tool",
    toolCallId: "c1",
    content: "r",
    isError: true,
  });
  // is_error absent defaults to false (C# TryGetProperty), never a throw.
  assert.deepEqual(parseCheckpointMessage({ role: "tool", call_id: "c1", text: "r" }, 5), {
    role: "tool",
    toolCallId: "c1",
    content: "r",
    isError: false,
  });
  assert.throws(
    () => parseCheckpointMessage({ role: "ghost", blocks: [] }, 6),
    (error: unknown) => error instanceof Error && /Unknown checkpoint role 'ghost'/.test(error.message) && /line 6/.test(error.message),
  );
});

test("parseCheckpointBlock rejects unknown block types with the line number", () => {
  assert.throws(
    () => parseCheckpointBlock({ type: "future_tool_state", text: "x" }, 9),
    (error: unknown) => error instanceof Error && /Unknown checkpoint content block type 'future_tool_state'/.test(error.message) && /line 9/.test(error.message),
  );
});

test("parseCheckpointMessage normalizes missing/mistyped fields into line-numbered errors", () => {
  assert.throws(
    () => parseCheckpointMessage({ role: "assistant" }, 2),
    (error: unknown) => error instanceof Error && /line 2/.test(error.message),
  );
  assert.throws(
    () => parseCheckpointMessage({ role: "system", text: 42 }, 2),
    (error: unknown) => error instanceof Error && /line 2/.test(error.message),
  );
});
