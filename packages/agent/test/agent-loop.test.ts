import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type {
  ChatModel,
  ContentBlock,
  FinishReason,
  ModelEvent,
  ModelRequest,
  ModelResponse,
  ToolSpec,
} from "@di/ai";
import type { AgentDependencies, AgentEvent, AgentRequest } from "@di/agent";
import { LoopError, runAgentLoop } from "@di/agent";

import type { Fixture, LoopFixture, ModelScriptJson, ModelStepJson } from "./fixture-schema.ts";
import { isLoopFixture } from "./fixture-schema.ts";
import { RecordingExecutor } from "./recording-executor.ts";

/**
 * P2.1 loop tests (docs/migration/typescript-core/loop-and-state.md §"一回合精确时序").
 *
 * The pure-answer fixture is the primary contract: a single tool-free model call
 * returns stopReason=answer with the fixture's trajectory, usage, iterations and
 * eventSequence. Expected values come from the C# baseline tests at 09f4e08 —
 * never from generated TS output. The fixture's scripted model yields exactly one
 * `completed` (the non-streaming semantics the fixtures' eventSequence assumes);
 * delta forwarding is exercised by a separate streaming model.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");
const FIXED_TIMESTAMP = 1_700_000_000_000;

function loadLoopFixture(fileName: string): LoopFixture {
  const raw = readFileSync(path.join(FIXTURES_DIR, fileName), "utf8");
  const fixture = JSON.parse(raw) as Fixture;
  assert.ok(isLoopFixture(fixture), `${fileName}: expected a loop fixture`);
  return fixture;
}

/** Convert a schema-validated fixture input into the loop's typed request. */
function toAgentRequest(fixture: LoopFixture): AgentRequest {
  const input = fixture.input;
  return {
    sessionId: input.sessionId,
    systemPrompt: input.systemPrompt,
    userMessage: input.userMessage,
    history: input.history as unknown as AgentRequest["history"],
    systemContext: input.systemContext ?? undefined,
    tools: input.tools as unknown as readonly ToolSpec[],
    contextTokenBudget: input.contextTokenBudget ?? undefined,
    maxIterations: input.maxIterations,
    maxTokens: input.maxTokens ?? undefined,
    reasoningEffort: input.reasoningEffort ?? undefined,
    finalOutputTool: input.finalOutputTool ?? undefined,
  };
}

/**
 * A scripted @di/ai ChatModel driven by a fixture's `model` script. Each call
 * yields exactly one `completed` carrying the assembled ModelResponse. Deltas
 * are emitted only by models that choose to stream them.
 */
class ScriptedModel implements ChatModel {
  readonly requests: ModelRequest[] = [];
  private readonly responses_: readonly ModelStepJson[];
  private callIndex_ = 0;

  constructor(script: ModelScriptJson) {
    this.responses_ = script.responses;
  }

  get callCount(): number {
    return this.callIndex_;
  }

  stream(request: ModelRequest, _signal?: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const step = this.responses_[this.callIndex_];
    this.callIndex_ += 1;
    if (step === undefined || step.failure !== null) {
      throw new Error(`ScriptedModel: no completed step for model call #${this.callIndex_}`);
    }
    const response: ModelResponse = {
      message: { role: "assistant", content: assistantContent(step) },
      finishReason: toFinishReason(step.finishReason),
      usage: { ...step.usage },
      model: step.model,
      ...(step.cost === null ? {} : { cost: { ...step.cost } }),
      timestamp: FIXED_TIMESTAMP,
      durationMs: 12,
    };
    return (async function* (): AsyncGenerator<ModelEvent> {
      yield { type: "completed", response };
    })();
  }
}

function assistantContent(step: ModelStepJson): readonly ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (step.text !== null) {
    blocks.push({ type: "text", text: step.text });
  }
  for (const call of step.toolCalls) {
    blocks.push({ type: "tool-call", id: call.id, name: call.name, arguments: call.arguments });
  }
  return blocks;
}

function toFinishReason(reason: "stop" | "tool-calls" | "max-tokens"): FinishReason {
  switch (reason) {
    case "stop":
      return { type: "stop" };
    case "tool-calls":
      return { type: "tool-calls" };
    case "max-tokens":
      return { type: "max-tokens" };
  }
}

/** Dependencies for a tool-free run: the unused executor/estimator are inert. */
function toolFreeDependencies(model: ChatModel, onEvent?: (event: AgentEvent) => void): AgentDependencies {
  return {
    model,
    toolExecutor: new RecordingExecutor(() => ({ text: "unexpected tool call", isError: true })),
    estimateRequestTokens: () => 0,
    events: onEvent,
  };
}

test("pure-answer fixture: a tool-free model returns the expected answer and trajectory", async () => {
  const fixture = loadLoopFixture("pure-answer.json");
  const model = new ScriptedModel(fixture.input.model);
  const events: AgentEvent[] = [];
  const executor = new RecordingExecutor(() => ({ text: "unexpected tool call", isError: true }));

  const result = await runAgentLoop(toAgentRequest(fixture), {
    model,
    toolExecutor: executor,
    estimateRequestTokens: () => 0,
    events: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.stopReason, fixture.expected.stopReason);
  assert.equal(result.answer, fixture.expected.answer);
  assert.equal(result.iterations, fixture.expected.iterations);
  assert.deepEqual(result.usage, fixture.expected.usage);
  assert.equal(result.cost ?? null, fixture.expected.cost);
  assert.equal(result.failure ?? null, fixture.expected.failure);
  assert.equal(model.callCount, fixture.expected.modelRequestCount);
  assert.equal(executor.calls.length, 0, "the tool-free path must not execute tools");
  assert.equal(result.trajectory.length, fixture.expected.trajectoryCount);
  assert.deepEqual(result.trajectory, fixture.expected.trajectory);
  assert.deepEqual(
    events.map((event) => event.type),
    fixture.expected.eventSequence,
  );
});

test("model request context is the stable system prompt then the trajectory", async () => {
  const model = new ScriptedModel({
    responses: [
      { text: "ok", toolCalls: [], finishReason: "stop", failure: null, usage: { inputTokens: 0, outputTokens: 0 }, cost: null, model: "fake" },
    ],
  });

  await runAgentLoop(
    { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "hi", history: [], tools: [] },
    toolFreeDependencies(model),
  );

  const request = model.requests[0];
  assert.ok(request, "expected one model request");
  assert.deepEqual(request.messages, [
    { role: "system", text: "test system prompt" },
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ]);
});

test("systemContext is appended as a trailing system message", async () => {
  const model = new ScriptedModel({
    responses: [
      { text: "ok", toolCalls: [], finishReason: "stop", failure: null, usage: { inputTokens: 0, outputTokens: 0 }, cost: null, model: "fake" },
    ],
  });

  await runAgentLoop(
    {
      sessionId: "s1",
      systemPrompt: "test system prompt",
      userMessage: "hi",
      history: [],
      tools: [],
      systemContext: "## env\n- cwd: /tmp/x",
    },
    toolFreeDependencies(model),
  );

  const request = model.requests[0];
  assert.ok(request, "expected one model request");
  assert.deepEqual(request.messages, [
    { role: "system", text: "test system prompt" },
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "system", text: "## env\n- cwd: /tmp/x" },
  ]);
});

test("an empty systemPrompt contributes no system message", async () => {
  const model = new ScriptedModel({
    responses: [
      { text: "ok", toolCalls: [], finishReason: "stop", failure: null, usage: { inputTokens: 0, outputTokens: 0 }, cost: null, model: "fake" },
    ],
  });

  await runAgentLoop(
    { sessionId: "s1", systemPrompt: "", userMessage: "hi", history: [], tools: [] },
    toolFreeDependencies(model),
  );

  const request = model.requests[0];
  assert.ok(request, "expected one model request");
  assert.deepEqual(request.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("history is prepended before the current user message and returned untouched", async () => {
  const history = [
    { role: "user", content: [{ type: "text", text: "previous question" }] },
    { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
  ];
  const model = new ScriptedModel({
    responses: [
      { text: "ok", toolCalls: [], finishReason: "stop", failure: null, usage: { inputTokens: 0, outputTokens: 0 }, cost: null, model: "fake" },
    ],
  });

  const result = await runAgentLoop(
    {
      sessionId: "s1",
      systemPrompt: "test system prompt",
      userMessage: "current question",
      history: history as unknown as AgentRequest["history"],
      tools: [],
    },
    toolFreeDependencies(model),
  );

  const request = model.requests[0];
  assert.ok(request, "expected one model request");
  assert.equal(request.messages.length, 4);
  assert.deepEqual(request.messages, [
    { role: "system", text: "test system prompt" },
    { role: "user", content: [{ type: "text", text: "previous question" }] },
    { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
    { role: "user", content: [{ type: "text", text: "current question" }] },
  ]);
  assert.deepEqual(result.trajectory, [
    { role: "user", content: [{ type: "text", text: "previous question" }] },
    { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
    { role: "user", content: [{ type: "text", text: "current question" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ]);
  assert.equal(result.history, history, "the caller's history reference must be returned untouched");
  assert.equal(history.length, 2, "the loop must not mutate the caller's history");
});

test("stream deltas are forwarded in order before turnCompleted", async () => {
  const model: ChatModel = {
    stream(): AsyncIterable<ModelEvent> {
      return (async function* (): AsyncGenerator<ModelEvent> {
        yield { type: "textDelta", delta: "hel" };
        yield { type: "reasoningDelta", delta: "think" };
        yield { type: "textDelta", delta: "lo" };
        yield {
          type: "completed",
          response: {
            message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
            finishReason: { type: "stop" },
            usage: { inputTokens: 5, outputTokens: 7 },
            model: "fake",
            timestamp: FIXED_TIMESTAMP,
          },
        };
      })();
    },
  };
  const events: AgentEvent[] = [];

  const result = await runAgentLoop(
    { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "hi", history: [], tools: [] },
    toolFreeDependencies(model, (event) => {
      events.push(event);
    }),
  );

  assert.equal(result.answer, "hello");
  assert.equal(result.stopReason, "answer");
  assert.deepEqual(events, [
    { type: "textDelta", delta: "hel" },
    { type: "reasoningDelta", delta: "think" },
    { type: "textDelta", delta: "lo" },
    {
      type: "turnCompleted",
      iteration: 1,
      usage: { inputTokens: 5, outputTokens: 7 },
      finishReason: { type: "stop" },
    },
  ]);
});

test("empty userMessage and empty tools are handled without crashing", async () => {
  const model = new ScriptedModel({
    responses: [
      { text: "ok", toolCalls: [], finishReason: "stop", failure: null, usage: { inputTokens: 0, outputTokens: 0 }, cost: null, model: "fake" },
    ],
  });

  const result = await runAgentLoop(
    { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "", history: [], tools: [] },
    toolFreeDependencies(model),
  );

  assert.equal(result.stopReason, "answer");
  assert.equal(result.answer, "ok");
  assert.deepEqual(result.trajectory, [
    { role: "user", content: [{ type: "text", text: "" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ]);
});

test("a model stream without a completed event is rejected", async () => {
  const emptyStream: ChatModel = {
    stream() {
      return (async function* (): AsyncGenerator<ModelEvent> {})();
    },
  };

  await assert.rejects(
    runAgentLoop(
      { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "hi", history: [], tools: [] },
      toolFreeDependencies(emptyStream),
    ),
    (error: unknown) => error instanceof LoopError && error.code === "missing-completed",
  );
});

test("out-of-range request parameters are rejected at loop start", async () => {
  const base: AgentRequest = {
    sessionId: "s1",
    systemPrompt: "test system prompt",
    userMessage: "hi",
    history: [],
    tools: [],
  };
  const model = new ScriptedModel({ responses: [] }); // never reached
  const patches: ReadonlyArray<Partial<AgentRequest>> = [
    { maxIterations: -1 },
    { maxIterations: 1.5 },
    { maxTokens: 0 },
    { maxTokens: -3 },
    { maxTokens: 1.5 },
    { contextTokenBudget: -1 },
    { contextTokenBudget: 0.5 },
  ];

  for (const patch of patches) {
    await assert.rejects(
      runAgentLoop({ ...base, ...patch }, toolFreeDependencies(model)),
      RangeError,
      `expected RangeError for ${JSON.stringify(patch)}`,
    );
  }
});

test("a model tool-call request fails loudly until the tool phase card lands", async () => {
  const toolCallModel: ChatModel = {
    stream() {
      return (async function* (): AsyncGenerator<ModelEvent> {
        yield {
          type: "completed",
          response: {
            message: {
              role: "assistant",
              content: [{ type: "tool-call", id: "c1", name: "echo", arguments: "{}" }],
            },
            finishReason: { type: "tool-calls" },
            usage: { inputTokens: 1, outputTokens: 2 },
            model: "fake",
            timestamp: FIXED_TIMESTAMP,
          },
        };
      })();
    },
  };

  await assert.rejects(
    runAgentLoop(
      { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "hi", history: [], tools: [] },
      toolFreeDependencies(toolCallModel),
    ),
    (error: unknown) => error instanceof LoopError && error.code === "tool-phase-not-implemented",
  );
});
