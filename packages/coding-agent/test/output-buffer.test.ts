import test from "node:test";
import assert from "node:assert/strict";

import {
  BoundedByteBuffer,
  OUTPUT_HEAD_BYTES,
  OUTPUT_HEAD_CHARS,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_CHARS,
  OUTPUT_TAIL_BYTES,
  OUTPUT_TAIL_CHARS,
  OutputBuffer,
} from "@di/coding-agent";

/**
 * P4.4 card 8: bounded output accumulation.
 *
 * Ports Di.Tests/Tools/OutputBufferTests.cs (char accumulator) at baseline
 * 09f4e08 and adds focused BoundedByteBuffer cases (byte accumulator, used by
 * the one-shot process runner so the whole segment can be smart-decoded after
 * exit). Core invariant: for any output length the final text stays within the
 * head + tail budget, the dropped middle is replaced by a truncation notice, and
 * head/tail content is preserved — never unbounded concatenation, never
 * collect-then-truncate (C# OutputBuffer/BoundedByteBuffer semantics).
 *
 * The over-budget cases are RED by failed assertions in the scaffold commit:
 * the accumulator keeps everything, so the truncation notice is absent and the
 * text exceeds the budget.
 */

const utf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes);

test("empty buffer returns empty text", () => {
  const buffer = new OutputBuffer();
  assert.equal(buffer.text, "");
  assert.equal(buffer.truncated, false);
  assert.equal(buffer.totalChars, 0);
});

test("under-budget output returns the full text", () => {
  const buffer = new OutputBuffer();
  buffer.appendLine("one");
  buffer.appendLine("two");
  assert.equal(buffer.truncated, false);
  assert.equal(buffer.text, "one\ntwo\n");
});

test("head filled but still within budget has no truncation marker", () => {
  const buffer = new OutputBuffer();
  buffer.append("a".repeat(OUTPUT_HEAD_CHARS));
  buffer.append("b".repeat(OUTPUT_TAIL_CHARS));
  assert.equal(buffer.truncated, false);
  const text = buffer.text;
  assert.ok(!text.includes("已截断"), text);
  assert.ok(text.startsWith("a".repeat(OUTPUT_HEAD_CHARS)), "head preserved");
  assert.ok(text.endsWith("b".repeat(OUTPUT_TAIL_CHARS)), "tail preserved");
});

test("over-budget output keeps head and tail with the truncation marker", () => {
  const buffer = new OutputBuffer();
  buffer.append("a".repeat(OUTPUT_HEAD_CHARS));
  buffer.append("b".repeat(500));
  buffer.append("c".repeat(OUTPUT_TAIL_CHARS + 2000));

  const text = buffer.text;

  assert.equal(buffer.truncated, true);
  assert.ok(text.startsWith("a".repeat(OUTPUT_HEAD_CHARS)), "head kept in full");
  assert.ok(text.includes("已截断"), "truncation notice present");
  assert.ok(!text.includes("b"), "dropped middle is gone");
  assert.ok(text.endsWith("c".repeat(OUTPUT_TAIL_CHARS)), "tail keeps the newest output");
  assert.ok(
    text.length <= OUTPUT_MAX_CHARS + 100,
    `text must stay within budget: ${text.length}`,
  );
  assert.ok(buffer.totalChars > OUTPUT_MAX_CHARS, "TotalChars counts the dropped middle too");
});

test("single huge line keeps head and tail within budget", () => {
  const buffer = new OutputBuffer();
  buffer.append("x".repeat(100_000));
  const text = buffer.text;

  assert.equal(buffer.truncated, true);
  assert.ok(text.startsWith("x".repeat(OUTPUT_HEAD_CHARS)), "head kept");
  assert.ok(text.endsWith("x".repeat(OUTPUT_TAIL_CHARS)), "tail kept");
  assert.ok(text.length <= OUTPUT_MAX_CHARS + 100, `bounded: ${text.length}`);
});

test("many lines stay bounded", () => {
  const buffer = new OutputBuffer();
  for (let i = 0; i < 10_000; i += 1) buffer.appendLine(`line ${i} content here`);
  const text = buffer.text;

  assert.equal(buffer.truncated, true);
  assert.ok(text.includes("已截断"), text);
  assert.ok(text.length <= OUTPUT_MAX_CHARS + 100, `bounded: ${text.length}`);
});

// ---- BoundedByteBuffer (bytes) ----

test("empty byte buffer returns empty text", () => {
  const buffer = new BoundedByteBuffer();
  assert.equal(buffer.truncated, false);
  assert.equal(buffer.totalBytes, 0);
  assert.equal(buffer.toText(utf8), "");
});

test("under-budget bytes decode as one contiguous segment", () => {
  const buffer = new BoundedByteBuffer();
  buffer.append(Buffer.from("hello", "utf8"));
  buffer.append(Buffer.from(" world", "utf8"));
  assert.equal(buffer.truncated, false);
  assert.equal(buffer.totalBytes, 11);
  assert.equal(buffer.toText(utf8), "hello world");
});

test("over-budget bytes keep head and tail with a byte-counted notice", () => {
  const buffer = new BoundedByteBuffer();
  buffer.append(Buffer.from("A".repeat(OUTPUT_HEAD_BYTES), "utf8"));
  buffer.append(Buffer.from("B".repeat(300), "utf8"));
  buffer.append(Buffer.from("C".repeat(OUTPUT_TAIL_BYTES + 2000), "utf8"));

  const text = buffer.toText(utf8);

  assert.equal(buffer.truncated, true);
  assert.equal(buffer.totalBytes, OUTPUT_HEAD_BYTES + 300 + OUTPUT_TAIL_BYTES + 2000);
  assert.ok(text.startsWith("A".repeat(OUTPUT_HEAD_BYTES)), "head kept");
  assert.ok(text.includes("已截断"), "truncation notice present");
  assert.ok(text.includes("字节"), "byte-counted notice");
  assert.ok(!text.includes("B"), "dropped middle is gone");
  assert.ok(text.endsWith("C".repeat(OUTPUT_TAIL_BYTES)), "tail keeps the newest bytes");
  assert.ok(text.length <= OUTPUT_MAX_BYTES + 100, `bounded: ${text.length}`);
});
