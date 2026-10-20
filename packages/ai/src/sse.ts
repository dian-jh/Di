import type { ModelEvent } from "./types/stream.ts";
import type { ProviderChunk } from "./stream-assembler.ts";
import { ProviderStreamAssembler } from "./stream-assembler.ts";

/**
 * P3 card 2 HTTP/SSE framing (Di baseline `Core/Providers/DeepSeek/DeepSeekAdapter.cs`
 * SSE parsing + models-and-auth.md §DeepSeek 协议边界 item 1; W3C SSE field syntax).
 *
 * {@link SseEventParser} is the pure line/field state machine: it consumes decoded
 * text and produces SSE events, handling data/event/id fields, multi-line data,
 * comment lines (`:`), CRLF/LF/lone-CR line endings, and arbitrary chunk splits.
 * {@link parseSseStream} decodes a byte {@link ReadableStream} (handling multi-byte
 * UTF-8 split across frames) and yields events with an idle timeout and abort guard.
 * {@link sseToModelEvents} wires a translate callback and the P3.1
 * {@link ProviderStreamAssembler} into an `AsyncIterable<ModelEvent>` suitable for
 * `ChatModel.stream`. It yields exactly one `completed` per stream (unless a
 * terminal transport/protocol error is thrown) and never hangs when the underlying
 * stream errors or the caller aborts.
 *
 * DeepSeek wire translation, usage/cost and retry are later P3 cards; they only
 * plug in through the {@link TranslateEvent} callback.
 */

/** One parsed SSE event (W3C: an `event` type, joined `data`, last `id`). */
export interface SseEvent {
  /** Value of the last `event:` field; defaults to `"message"`. */
  readonly event: string;
  /** `data:` field values joined with `\n` (SSE multi-line data semantics). */
  readonly data: string;
  /** Value of the last `id:` field within this event, when present. */
  readonly id?: string;
}

/**
 * Structured transport/protocol error thrown out of {@link parseSseStream} and
 * {@link sseToModelEvents}. `code` is a stable discriminator: `"connection"`
 * (stream read failed or EOF without a terminal finish), `"timeout"` (idle
 * timeout), `"aborted"` (caller signal fired). These are the defined error path
 * for `ModelEvent` streams: {@link ModelEvent} has no error variant, so transport
 * failures throw out of the async iterator instead of fabricating a success;
 * in-band provider errors instead arrive as `completed` with an error
 * `finishReason` (see {@link ProviderStreamAssembler}).
 */
export class SseStreamError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SseStreamError";
    this.code = code;
  }
}

/**
 * Streaming SSE event parser. Feed decoded text with {@link push}; a pending
 * event is dispatched when a blank line arrives (or via {@link end} at EOF).
 * The parser is byte/decoder-agnostic and split-safe: a CRLF pair, a field, or a
 * multi-line event may be split anywhere across `push` calls.
 */
export class SseEventParser {
  private line = "";
  private pendingCarriageReturn = false;
  private readonly dataLines: string[] = [];
  private eventType: string | undefined;
  private lastId: string | undefined;

  /** Feed one decoded text fragment; returns any events completed by it. */
  push(text: string): readonly SseEvent[] {
    const produced: SseEvent[] = [];
    for (const ch of text) {
      if (ch === "\r") {
        // A CR may be the first half of a CRLF; hold it until the next char.
        this.pendingCarriageReturn = true;
        continue;
      }
      if (ch === "\n") {
        produced.push(...this.processLine(this.line));
        this.line = "";
        this.pendingCarriageReturn = false;
        continue;
      }
      if (this.pendingCarriageReturn) {
        // Lone CR line ending (not followed by LF).
        produced.push(...this.processLine(this.line));
        this.line = "";
        this.pendingCarriageReturn = false;
      }
      this.line += ch;
    }
    return produced;
  }

  /** Signal EOF: flush the final partial line and any pending event. */
  end(): readonly SseEvent[] {
    const produced: SseEvent[] = [];
    if (this.line.length > 0 || this.pendingCarriageReturn) {
      produced.push(...this.processLine(this.line));
      this.line = "";
      this.pendingCarriageReturn = false;
    }
    // W3C SSE dispatches at EOF only when a data event is pending; a persisted
    // last event id alone must not fabricate an empty-data event.
    if (this.dataLines.length > 0) {
      produced.push(...this.dispatch());
    }
    return produced;
  }

  private processLine(line: string): readonly SseEvent[] {
    if (line.length === 0) {
      // Blank line: dispatch any pending event.
      return this.dispatch();
    }
    if (line.startsWith(":")) {
      // Comment line: ignored.
      return [];
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (colon !== -1 && value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "") {
      return [];
    }
    switch (field) {
      case "data":
        this.dataLines.push(value);
        return [];
      case "event":
        this.eventType = value;
        return [];
      case "id":
        if (value !== "") this.lastId = value;
        return [];
      default:
        // Unknown fields are ignored (W3C SSE).
        return [];
    }
  }

  private dispatch(): readonly SseEvent[] {
    if (this.dataLines.length === 0 && this.lastId === undefined) {
      return [];
    }
    const event: SseEvent = {
      event: this.eventType ?? "message",
      data: this.dataLines.join("\n"),
      ...(this.lastId !== undefined ? { id: this.lastId } : {}),
    };
    this.dataLines.length = 0;
    this.eventType = undefined;
    return [event];
  }
}

/** Options for {@link parseSseStream}. */
export interface ParseSseStreamOptions {
  /** Abort reading (and cancel the reader) when the caller's signal fires. */
  readonly signal?: AbortSignal;
  /**
   * Idle deadline between byte reads. If no byte arrives within this many
   * milliseconds the stream throws an `"timeout"` {@link SseStreamError}. Omitted
   * or non-positive disables the timer. Each read arms a timer that is always
   * cleared on settle, so no timer outlives the stream.
   */
  readonly idleTimeoutMs?: number;
}

/**
 * Read one byte chunk from the underlying stream, racing it against the idle
 * timeout and the caller's abort signal. The timer is created per read and
 * cleared on settle/abort, so it never leaks. The `reader` lock is released by
 * the caller's `finally`.
 */
async function readWithGuard(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = (): void => {
      // Close the reader so a cancelled call never keeps the connection alive.
      void reader.cancel().catch(() => {});
      settle(() => reject(new SseStreamError("aborted", "SSE stream aborted")));
    };

    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
      timer = setTimeout(() => {
        settle(() =>
          reject(new SseStreamError("timeout", `no SSE bytes within ${idleTimeoutMs}ms`)),
        );
      }, idleTimeoutMs);
    }
    reader.read().then(
      (result) => settle(() => resolve(result)),
      (error) => settle(() => reject(classifyReadError(error, signal))),
    );
  });
}

/** Classify an underlying read rejection: abort vs connection failure. */
function classifyReadError(error: unknown, signal: AbortSignal | undefined): SseStreamError {
  if (signal?.aborted) {
    return new SseStreamError("aborted", "SSE stream aborted", { cause: error });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new SseStreamError("aborted", "SSE stream aborted", { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new SseStreamError("connection", `SSE stream read failed: ${message}`, { cause: error });
}

/**
 * Decode a byte {@link ReadableStream} and yield each parsed SSE event as it
 * completes. Handles multi-byte UTF-8 sequences split across chunks
 * (`TextDecoder` in streaming mode), CRLF/LF/lone-CR line endings, and events
 * split across arbitrary chunk boundaries. On clean EOF any pending event is
 * dispatched (the final partial line is honored, matching the C# baseline's
 * line-oriented reader). A stalled stream throws `"timeout"`; a failing stream
 * throws `"connection"`; an aborted signal throws `"aborted"` — all as
 * {@link SseStreamError}, never hanging.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  options: ParseSseStreamOptions = {},
): AsyncGenerator<SseEvent, void, unknown> {
  const { idleTimeoutMs, signal } = options;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = new SseEventParser();

  try {
    while (true) {
      if (signal?.aborted) {
        throw new SseStreamError("aborted", "SSE stream aborted");
      }
      const result = await readWithGuard(reader, idleTimeoutMs, signal);
      if (result.done) {
        break;
      }
      const text = decoder.decode(result.value, { stream: true });
      for (const event of parser.push(text)) {
        yield event;
      }
    }
    // EOF: flush any remaining decoded text and pending event.
    for (const event of parser.push(decoder.decode())) {
      yield event;
    }
    for (const event of parser.end()) {
      yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Maps one parsed SSE event onto the low-level provider chunk vocabulary. */
export type TranslateEvent = (event: SseEvent) => readonly ProviderChunk[];

/** Options for {@link sseToModelEvents}. */
export interface SseToModelEventsOptions {
  /** Model id actually invoked; carried into `ModelResponse.model`. */
  readonly model: string;
  /** SSE event → provider chunk translator (the provider-specific wire codec). */
  readonly translateEvent: TranslateEvent;
  /** Request start in Unix milliseconds; defaults to stream start. */
  readonly timestamp?: number;
  /** Idle deadline forwarded to {@link parseSseStream}. */
  readonly idleTimeoutMs?: number;
  /** Abort signal forwarded to {@link parseSseStream}. */
  readonly signal?: AbortSignal;
}

/**
 * Drive an SSE byte stream through {@link TranslateEvent} and the P3.1
 * {@link ProviderStreamAssembler}, yielding high-level {@link ModelEvent} deltas
 * as they arrive and exactly one `completed` carrying the assembled
 * {@link ModelResponse}. Suitable for the body of `ChatModel.stream`.
 *
 * - a stream ending after a terminal `finish` chunk yields exactly one
 *   `completed` (even if only `finish` was sent);
 * - a stream ending without a terminal finish is a protocol truncation and throws
 *   an `"connection"` {@link SseStreamError} (nothing is fabricated);
 * - transport failures (stream error, idle timeout, abort) propagate the
 *   {@link SseStreamError} thrown by {@link parseSseStream};
 * - in-band errors arrive as `completed` with an error `finishReason` via the
 *   assembler; chunks after a finish chunk throw `chunk-after-finish`.
 */
export async function* sseToModelEvents(
  stream: ReadableStream<Uint8Array>,
  options: SseToModelEventsOptions,
): AsyncGenerator<ModelEvent, void, unknown> {
  const { model, timestamp, translateEvent, idleTimeoutMs, signal } = options;
  const assembler = new ProviderStreamAssembler({ model, timestamp });
  let sawFinish = false;

  for await (const event of parseSseStream(stream, { idleTimeoutMs, signal })) {
    for (const chunk of translateEvent(event)) {
      if (chunk.type === "finish") {
        sawFinish = true;
      }
      for (const delta of assembler.add(chunk)) {
        yield delta;
      }
    }
  }

  if (sawFinish) {
    yield assembler.finish();
    return;
  }
  throw new SseStreamError("connection", "SSE stream ended without a terminal finish chunk");
}
