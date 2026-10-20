import test from "node:test";
import assert from "node:assert/strict";

import type { ChatModel, ModelEvent, ModelRequest } from "@di/ai";
import {
  RETRY_DEFAULTS,
  RetryingChatModel,
  SseStreamError,
  DeepSeekError,
  deepSeekErrorCodes,
} from "@di/ai";

/**
 * P3 card 5 business tests — the {@link RetryingChatModel} wrapper (Di baseline
 * `Core/Llm/RetryingChatModel.cs`, boundary fixed per models-and-auth.md
 * §重试边界: retry only before the first {@link ModelEvent}). Tools run in the
 * agent loop, never in the transport — once any delta (including a toolCallDelta)
 * has been delivered downstream, a later stream failure is rethrown and no
 * second attempt is issued, so a retried request can never replay a tool call.
 * Cancellation (AbortSignal) is never retried.
 */

const request: ModelRequest = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };

function completedEvent(): ModelEvent {
  return {
    type: "completed",
    response: {
      message: { role: "assistant", content: [] },
      finishReason: { type: "stop" },
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "fake",
      timestamp: 0,
    },
  };
}

type Script = (attempt: number) => AsyncGenerator<ModelEvent>;

/** A {@link ChatModel} that runs the Nth script on the Nth attempt and counts them. */
function scriptedModel(scripts: readonly Script[]): ChatModel & { attempts(): number } {
  let attempts = 0;
  return {
    async *stream() {
      attempts += 1;
      const script = scripts[attempts - 1];
      if (script === undefined) {
        throw new Error(`no script for attempt ${attempts}`);
      }
      yield* script(attempts);
    },
    attempts: () => attempts,
  };
}

/** Records every wait; resolves immediately so tests never sleep for real. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    waits,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<readonly T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test("retries a retryable connection error before the first event and delivers a clean stream", async () => {
  const model = scriptedModel([
    async function* () {
      throw new SseStreamError("connection", "drop");
    },
    async function* () {
      yield completedEvent();
    },
  ]);
  const { sleep, waits } = recordingSleep();
  const retrying = new RetryingChatModel(model, { jitterRatio: 0 }, sleep);

  const events = await collect(retrying.stream(request));
  assert.deepEqual(events.map((e) => e.type), ["completed"]);
  assert.equal(model.attempts(), 2);
  assert.deepEqual(waits, [RETRY_DEFAULTS.initialBackoffMs]);
});

test("waits the provider Retry-After before retrying a 429", async () => {
  const model = scriptedModel([
    async function* () {
      throw new DeepSeekError({
        message: "rate limit",
        code: deepSeekErrorCodes.rateLimited,
        status: 429,
        providerRetryAfterMs: 5000,
      });
    },
    async function* () {
      yield completedEvent();
    },
  ]);
  const { sleep, waits } = recordingSleep();
  const retrying = new RetryingChatModel(model, { jitterRatio: 0 }, sleep);

  await collect(retrying.stream(request));
  assert.equal(model.attempts(), 2);
  assert.deepEqual(waits, [5000]);
});

test("retries an SSE idle timeout (SseStreamError timeout code)", async () => {
  const model = scriptedModel([
    async function* () {
      throw new SseStreamError("timeout", "idle");
    },
    async function* () {
      yield completedEvent();
    },
  ]);
  const { sleep, waits } = recordingSleep();
  const retrying = new RetryingChatModel(model, { jitterRatio: 0 }, sleep);

  await collect(retrying.stream(request));
  assert.equal(model.attempts(), 2);
  assert.deepEqual(waits, [RETRY_DEFAULTS.initialBackoffMs]);
});

test("stops after maxAttempts and throws the last retryable error", async () => {
  const model = scriptedModel([
    async function* () {
      throw new SseStreamError("connection", "a");
    },
    async function* () {
      throw new SseStreamError("connection", "b");
    },
    async function* () {
      throw new SseStreamError("connection", "c");
    },
  ]);
  const { sleep, waits } = recordingSleep();
  const retrying = new RetryingChatModel(
    model,
    { maxAttempts: 3, initialBackoffMs: 10, backoffMultiplier: 2, jitterRatio: 0 },
    sleep,
  );

  await assert.rejects(
    collect(retrying.stream(request)),
    (err) => err instanceof SseStreamError && err.code === "connection",
  );
  assert.equal(model.attempts(), 3);
  assert.deepEqual(waits, [10, 20]); // one exponential-backoff wait between the three attempts
});

test("never retries a non-retryable error", async () => {
  const model = scriptedModel([
    async function* () {
      throw new DeepSeekError({ message: "no key", code: deepSeekErrorCodes.missingCredential, status: 401 });
    },
  ]);
  const { sleep, waits } = recordingSleep();
  const retrying = new RetryingChatModel(model, {}, sleep);

  await assert.rejects(
    collect(retrying.stream(request)),
    (err) => err instanceof DeepSeekError && err.code === "MISSING_CREDENTIAL",
  );
  assert.equal(model.attempts(), 1);
  assert.deepEqual(waits, []);
});

test("cancellation during the attempt is never retried", async () => {
  const controller = new AbortController();
  const model = scriptedModel([
    async function* () {
      controller.abort();
      throw new SseStreamError("connection", "drop");
    },
  ]);
  const { sleep, waits } = recordingSleep();
  const retrying = new RetryingChatModel(model, {}, sleep);

  await assert.rejects(
    collect(retrying.stream(request, controller.signal)),
    (err) => err instanceof SseStreamError && err.code === "connection",
  );
  assert.equal(model.attempts(), 1);
  assert.deepEqual(waits, []);
});

test("an abort during the retry wait rejects and never issues a second attempt", async () => {
  const controller = new AbortController();
  const model = scriptedModel([
    async function* () {
      throw new SseStreamError("connection", "drop");
    },
    async function* () {
      yield completedEvent();
    },
  ]);
  const waits: number[] = [];
  const abortingSleep = async (ms: number): Promise<void> => {
    waits.push(ms);
    controller.abort();
    throw new SseStreamError("aborted", "retry wait aborted");
  };
  const retrying = new RetryingChatModel(model, {}, abortingSleep);

  await assert.rejects(
    collect(retrying.stream(request, controller.signal)),
    (err) => err instanceof SseStreamError && err.code === "aborted",
  );
  assert.equal(model.attempts(), 1);
  assert.deepEqual(waits, [RETRY_DEFAULTS.initialBackoffMs]);
});

test("an already-aborted signal fails fast without invoking the inner model", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const model: ChatModel = {
    async *stream() {
      called = true;
      yield completedEvent();
    },
  };
  const retrying = new RetryingChatModel(model, {});

  await assert.rejects(
    collect(retrying.stream(request, controller.signal)),
    (err) => err instanceof SseStreamError && err.code === "aborted",
  );
  assert.equal(called, false);
});

test("does not retry after the first ModelEvent has been delivered", async () => {
  const model = scriptedModel([
    async function* () {
      yield { type: "textDelta", delta: "partial" };
      throw new SseStreamError("connection", "mid-stream drop");
    },
    async function* () {
      yield completedEvent();
    },
  ]);
  const { sleep, waits } = recordingSleep();
  const retrying = new RetryingChatModel(model, {}, sleep);

  await assert.rejects(
    collect(retrying.stream(request)),
    (err) => err instanceof SseStreamError && err.code === "connection",
  );
  assert.equal(model.attempts(), 1);
  assert.deepEqual(waits, []);
});

test("a tool-call delta already delivered blocks retry (tools never replay)", async () => {
  const model = scriptedModel([
    async function* () {
      yield { type: "toolCallDelta", id: "call_1", name: "read_file", arguments: "{}" };
      throw new SseStreamError("connection", "drop");
    },
    async function* () {
      yield completedEvent();
    },
  ]);
  const { sleep, waits } = recordingSleep();
  const retrying = new RetryingChatModel(model, {}, sleep);

  await assert.rejects(
    collect(retrying.stream(request)),
    (err) => err instanceof SseStreamError && err.code === "connection",
  );
  assert.equal(model.attempts(), 1);
  assert.deepEqual(waits, []);
});

test("the already-delivered prefix is not replayed (consumer sees exactly one prefix)", async () => {
  const model = scriptedModel([
    async function* () {
      yield { type: "textDelta", delta: "first" };
      yield { type: "textDelta", delta: " second" };
      throw new SseStreamError("connection", "drop");
    },
    async function* () {
      yield { type: "textDelta", delta: "REPLAYED" };
      yield completedEvent();
    },
  ]);
  const { sleep, waits } = recordingSleep();
  const retrying = new RetryingChatModel(model, {}, sleep);

  const seen: string[] = [];
  await assert.rejects(
    (async () => {
      const iterator = retrying.stream(request)[Symbol.asyncIterator]();
      while (true) {
        const { done, value } = await iterator.next();
        if (done) break;
        seen.push(value.type === "textDelta" ? value.delta : `event:${value.type}`);
      }
    })(),
    (err) => err instanceof SseStreamError && err.code === "connection",
  );
  assert.deepEqual(seen, ["first", " second"]);
  assert.equal(model.attempts(), 1);
  assert.deepEqual(waits, []);
});

test("a clean successful stream is never retried", async () => {
  const model = scriptedModel([async function* () {
    yield completedEvent();
  }]);
  const { sleep, waits } = recordingSleep();
  const retrying = new RetryingChatModel(model, {}, sleep);

  const events = await collect(retrying.stream(request));
  assert.deepEqual(events.map((e) => e.type), ["completed"]);
  assert.equal(model.attempts(), 1);
  assert.deepEqual(waits, []);
});
