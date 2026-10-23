import test from "node:test";
import assert from "node:assert/strict";

import type { ModelEvent, ProviderChunk, SseEvent } from "@di/ai";
import { AssemblerError, SseEventParser, SseStreamError, parseSseStream, sseToModelEvents } from "@di/ai";

/**
 *
 * §DeepSeek 协议边界 item 1):
 * SSE field parsing (data/event/id, multi-line data, comments, CRLF/LF, optional
 * blank-line separation), byte-level chunk splitting/merging, multi-byte sequences
 * split across frames, clean EOF, mid-stream connection error, idle timeout.
 *
 * The generic raw translator below is test-only and deliberately NOT the DeepSeek
 *
 * chunk vocabulary so the framer → assembler wiring can be exercised end to end.
 */

type CompletedEvent = Extract<ModelEvent, { type: "completed" }>;

function isSseError(code: string): (err: unknown) => boolean {
  return (err) => err instanceof SseStreamError && err.code === code;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A ReadableStream that enqueues all chunks then closes immediately. */
function streamOf(...chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

/** A stream that enqueues the given chunks and then stalls forever (never closes). */
function stalledStream(...chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encode(chunk) : chunk);
      }
    },
  });
}

/** A stream that enqueues the given chunks and then errors the underlying connection. */
function erroringStream(...chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encode(chunk) : chunk);
      }
      // Deferred error: the queued chunk is delivered first, then the connection drops.
      queueMicrotask(() => controller.error(new Error("connection reset by peer")));
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<readonly T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function textOf(events: readonly ModelEvent[]): string {
  return events.filter((e) => e.type === "textDelta").map((e) => e.delta).join("");
}

function onlyCompleted(events: readonly ModelEvent[]): CompletedEvent["response"] {
  const completed = events.filter((e): e is CompletedEvent => e.type === "completed");
  assert.equal(completed.length, 1, "expected exactly one completed event");
  const event = completed[0];
  assert.ok(event, "completed event missing");
  return event.response;
}

interface RawPayload {
  type: string;
  delta?: string;
  id?: string;
  name?: string;
  argumentsDelta?: string;
  reason?: string;
  message?: string;
  code?: string;
}

/**
 * Generic raw SSE → chunk translator used only by these framing tests. It is NOT
 *
 * the provider chunk vocabulary to exercise the framer/assembler wiring.
 */
function rawTranslator(event: SseEvent): readonly ProviderChunk[] {
  const parsed = JSON.parse(event.data) as RawPayload;
  switch (parsed.type) {
    case "textStart":
      return [{ type: "blockStart", index: 0, block: { type: "text" } }];
    case "textDelta":
      return [{ type: "textDelta", index: 0, delta: parsed.delta ?? "" }];
    case "textEnd":
      return [{ type: "blockEnd", index: 0 }];
    case "toolStart":
      return [{ type: "blockStart", index: 0, block: { type: "tool-call" } }];
    case "toolDelta":
      return [
        {
          type: "toolCallDelta",
          index: 0,
          id: parsed.id,
          name: parsed.name,
          argumentsDelta: parsed.argumentsDelta ?? "",
        },
      ];
    case "toolEnd":
      return [{ type: "blockEnd", index: 0 }];
    case "finish":
      return [
        {
          type: "finish",
          reason: parsed.reason === "tool-calls" ? { type: "tool-calls" } : { type: "stop" },
        },
      ];
    case "error":
      return [
        {
          type: "finish",
          reason: {
            type: "error",
            failure: { message: parsed.message ?? "", code: parsed.code ?? "upstream" },
          },
        },
      ];
    default:
      return [];
  }
}

test("parses a single data event with LF line endings", async () => {
  const events = await collect(parseSseStream(streamOf("data: hello\n\n")));
  assert.deepEqual(events, [{ event: "message", data: "hello" }]);
});

test("parses consecutive events and preserves their order", async () => {
  const events = await collect(parseSseStream(streamOf("data: one\n\n", "data: two\n\n")));
  assert.deepEqual(events.map((e) => e.data), ["one", "two"]);
});

test("carries the event field name", async () => {
  const events = await collect(parseSseStream(streamOf("event: delta\ndata: x\n\n")));
  assert.deepEqual(events, [{ event: "delta", data: "x" }]);
});

test("carries the id field when present", async () => {
  const events = await collect(parseSseStream(streamOf("data: x\nid: 42\n\n")));
  assert.deepEqual(events, [{ event: "message", data: "x", id: "42" }]);
});

test("reports the last id across subsequent events", async () => {
  const events = await collect(parseSseStream(streamOf("data: x\nid: 42\n\ndata: y\n\n")));
  assert.deepEqual(events.map((e) => e.id), ["42", "42"]);
});

test("joins multi-line data fields with a newline", async () => {
  const events = await collect(parseSseStream(streamOf("data: a\ndata: b\n\n")));
  assert.deepEqual(events, [{ event: "message", data: "a\nb" }]);
});

test("preserves an empty trailing data line exactly as the SSE spec does", async () => {
  // "data: a" then "data:" (empty value) → buffer "a\n\n" → dispatched data "a\n".
  const events = await collect(parseSseStream(streamOf("data: a\ndata:\n\n")));
  assert.deepEqual(events, [{ event: "message", data: "a\n" }]);
});

test("ignores comment lines starting with a colon", async () => {
  const events = await collect(parseSseStream(streamOf(": keepalive\ndata: x\n: note\ndata: y\n\n")));
  assert.deepEqual(events, [{ event: "message", data: "x\ny" }]);
});

test("does not emit events for comments or blank lines without data", async () => {
  const events = await collect(parseSseStream(streamOf(": just a comment\n\n\n\n")));
  assert.deepEqual(events, []);
});

test("accepts CRLF line endings", async () => {
  const events = await collect(parseSseStream(streamOf("data: hi\r\n\r\n")));
  assert.deepEqual(events, [{ event: "message", data: "hi" }]);
});

test("accepts mixed LF and CRLF line endings", async () => {
  const events = await collect(parseSseStream(streamOf("data: a\r\ndata: b\n\n")));
  assert.deepEqual(events, [{ event: "message", data: "a\nb" }]);
});

test("treats a lone carriage return as a line ending", async () => {
  const events = await collect(parseSseStream(streamOf("data: a\rdata: b\r\r")));
  assert.deepEqual(events, [{ event: "message", data: "a\nb" }]);
});

test("splits a frame that straddles chunk boundaries", async () => {
  const events = await collect(parseSseStream(streamOf("data: hel", "lo\n\n")));
  assert.deepEqual(events, [{ event: "message", data: "hello" }]);
});

test("splits a field name/value across chunk boundaries", async () => {
  const events = await collect(parseSseStream(streamOf("data", ": hi\n\n")));
  assert.deepEqual(events, [{ event: "message", data: "hi" }]);
});

test("splits a CRLF pair across chunk boundaries", async () => {
  const events = await collect(parseSseStream(streamOf("data: hi\r", "\ndata: world\n\n")));
  assert.deepEqual(events, [{ event: "message", data: "hi\nworld" }]);
});

test("reassembles multi-byte UTF-8 split across byte chunks", async () => {
  const events = await collect(
    parseSseStream(
      streamOf("data: ", new Uint8Array([0xe4, 0xb8]), new Uint8Array([0xad, 0x0a, 0x0a])),
    ),
  );
  assert.deepEqual(events, [{ event: "message", data: "中" }]);
});

test("reassembles a multi-byte emoji split across byte chunks", async () => {
  const events = await collect(
    parseSseStream(
      streamOf("data: ", new Uint8Array([0xf0, 0x9f]), new Uint8Array([0x98, 0x80, 0x0a, 0x0a])),
    ),
  );
  assert.deepEqual(events, [{ event: "message", data: "😀" }]);
});

test("dispatches a pending event when the stream ends mid-event", async () => {
  const events = await collect(parseSseStream(streamOf("data: partial")));
  assert.deepEqual(events, [{ event: "message", data: "partial" }]);
});

test("ignores unknown fields", async () => {
  const events = await collect(parseSseStream(streamOf("foo: bar\ndata: x\n\n")));
  assert.deepEqual(events, [{ event: "message", data: "x" }]);
});

test("keeps colons and interior spaces in field values", async () => {
  const events = await collect(parseSseStream(streamOf("data: a:b c\n\n")));
  assert.deepEqual(events, [{ event: "message", data: "a:b c" }]);
});

test("SseEventParser pushes events incrementally and flushes on end", () => {
  const parser = new SseEventParser();
  assert.deepEqual(parser.push("data: hello\n"), []);
  assert.deepEqual(parser.push("\n"), [{ event: "message", data: "hello" }]);
  assert.deepEqual(parser.push("data: world"), []);
  assert.deepEqual(parser.end(), [{ event: "message", data: "world" }]);
});

test("glue streams text deltas and exactly one completed with a terminal finish", async () => {
  const events = await collect(
    sseToModelEvents(
      streamOf(
        'data: {"type":"textStart"}\n\n',
        'data: {"type":"textDelta","delta":"Hel"}\n\n',
        'data: {"type":"textDelta","delta":"lo"}\n\n',
        'data: {"type":"textEnd"}\n\n',
        'data: {"type":"finish"}\n\n',
      ),
      { model: "probe-model", translateEvent: rawTranslator },
    ),
  );
  assert.deepEqual(events.map((e) => e.type), ["textDelta", "textDelta", "completed"]);
  assert.equal(textOf(events), "Hello");
  const response = onlyCompleted(events);
  assert.deepEqual(response.finishReason, { type: "stop" });
  assert.deepEqual(response.message.content, [{ type: "text", text: "Hello" }]);
  assert.equal(response.model, "probe-model");
});

test("glue assembles a tool-call block from SSE deltas", async () => {
  const events = await collect(
    sseToModelEvents(
      streamOf(
        'data: {"type":"toolStart"}\n\n',
        'data: {"type":"toolDelta","id":"t1","name":"search","argumentsDelta":"{\\"q\\":\\""}\n\n',
        'data: {"type":"toolDelta","id":"t1","name":"search","argumentsDelta":"typing\\"}"}\n\n',
        'data: {"type":"toolEnd"}\n\n',
        'data: {"type":"finish","reason":"tool-calls"}\n\n',
      ),
      { model: "m", translateEvent: rawTranslator },
    ),
  );
  const response = onlyCompleted(events);
  assert.deepEqual(response.message.content, [
    { type: "tool-call", id: "t1", name: "search", arguments: '{"q":"typing"}' },
  ]);
  assert.deepEqual(response.finishReason, { type: "tool-calls" });
});

test("glue forwards in-band error finishes as completed with an error reason", async () => {
  const events = await collect(
    sseToModelEvents(
      streamOf(
        'data: {"type":"textStart"}\n\n',
        'data: {"type":"textDelta","delta":"partial"}\n\n',
        'data: {"type":"textEnd"}\n\n',
        'data: {"type":"error","message":"upstream boom","code":"upstream"}\n\n',
      ),
      { model: "m", translateEvent: rawTranslator },
    ),
  );
  const response = onlyCompleted(events);
  assert.deepEqual(response.finishReason, {
    type: "error",
    failure: { message: "upstream boom", code: "upstream" },
  });
  assert.deepEqual(response.message.content, [{ type: "text", text: "partial" }]);
});

test("glue emits one completed with an empty message for a terminal-only stream", async () => {
  const events = await collect(
    sseToModelEvents(streamOf('data: {"type":"finish"}\n\n'), {
      model: "m",
      translateEvent: rawTranslator,
    }),
  );
  const response = onlyCompleted(events);
  assert.deepEqual(response.finishReason, { type: "stop" });
  assert.deepEqual(response.message.content, []);
});

test("glue throws a connection error when the stream ends without a terminal finish", async () => {
  await assert.rejects(
    collect(
      sseToModelEvents(
        streamOf(
          'data: {"type":"textStart"}\n\n',
          'data: {"type":"textDelta","delta":"orphan"}\n\n',
          'data: {"type":"textEnd"}\n\n',
        ),
        { model: "m", translateEvent: rawTranslator },
      ),
    ),
    isSseError("connection"),
  );
});

test("glue throws a connection error when the underlying stream errors mid-way", async () => {
  await assert.rejects(
    collect(
      sseToModelEvents(
        erroringStream(
          'data: {"type":"textStart"}\n\n',
          'data: {"type":"textDelta","delta":"x"}\n\n',
          'data: {"type":"textEnd"}\n\n',
        ),
        { model: "m", translateEvent: rawTranslator },
      ),
    ),
    isSseError("connection"),
  );
});

test("glue throws a timeout error when no bytes arrive within the idle deadline", async () => {
  await assert.rejects(
    collect(
      sseToModelEvents(
        stalledStream(
          'data: {"type":"textStart"}\n\n',
          'data: {"type":"textDelta","delta":"x"}\n\n',
          'data: {"type":"textEnd"}\n\n',
        ),
        {
          model: "m",
          translateEvent: rawTranslator,
          idleTimeoutMs: 50,
        },
      ),
    ),
    isSseError("timeout"),
  );
});

test("glue aborts promptly when the caller signal fires mid-stream", async () => {
  const controller = new AbortController();
  const iter = sseToModelEvents(
    stalledStream(
      'data: {"type":"textStart"}\n\n',
      'data: {"type":"textDelta","delta":"x"}\n\n',
      'data: {"type":"textEnd"}\n\n',
    ),
    {
      model: "m",
      translateEvent: rawTranslator,
      signal: controller.signal,
    },
  );
  const first = await iter.next();
  assert.ok(!first.done);
  controller.abort();
  await assert.rejects(iter.next(), isSseError("aborted"));
});

test("maps an underlying AbortError to the aborted code rather than connection", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encode('data: {"type":"textStart"}\n\n'));
      controller.enqueue(encode('data: {"type":"textDelta","delta":"x"}\n\n'));
      controller.enqueue(encode('data: {"type":"textEnd"}\n\n'));
      queueMicrotask(() => controller.error(new DOMException("aborted", "AbortError")));
    },
  });
  await assert.rejects(
    collect(sseToModelEvents(stream, { model: "m", translateEvent: rawTranslator })),
    isSseError("aborted"),
  );
});

test("glue propagates translator errors without mistaking them for transport failures", async () => {
  const boom = new Error("translator boom");
  const translator = (_event: SseEvent): readonly ProviderChunk[] => {
    throw boom;
  };
  await assert.rejects(
    collect(sseToModelEvents(streamOf("data: x\n\n"), { model: "m", translateEvent: translator })),
    (err) => err === boom,
  );
});

test("glue rejects provider chunks arriving after a finish chunk", async () => {
  const translator = (event: SseEvent): readonly ProviderChunk[] => {
    if (event.data === "done") return [{ type: "finish", reason: { type: "stop" } }];
    return [
      { type: "blockStart", index: 0, block: { type: "text" } },
      { type: "textDelta", index: 0, delta: event.data },
      { type: "blockEnd", index: 0 },
    ];
  };
  await assert.rejects(
    collect(sseToModelEvents(streamOf("data: done\n\n", "data: late\n\n"), {
      model: "m",
      translateEvent: translator,
    })),
    (err) => err instanceof AssemblerError && err.code === "chunk-after-finish",
  );
});
