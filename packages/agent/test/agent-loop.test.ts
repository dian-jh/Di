import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type {
  AgentMessage,
  ChatModel,
  ContentBlock,
  FinishReason,
  ModelEvent,
  ModelRequest,
  ModelResponse,
  ToolCall,
  ToolSpec,
} from "@di/ai";
import type {
  AgentDependencies,
  AgentEvent,
  AgentRequest,
  LoopCheckpoint,
  ToolObservation,
  ToolValidator,
} from "@di/agent";
import { LoopError, runAgentLoop } from "@di/agent";

import type { Fixture, LoopFixture, ModelScriptJson, ModelStepJson } from "./fixture-schema.ts";
import { isLoopFixture } from "./fixture-schema.ts";
import { RecordingExecutor } from "./recording-executor.ts";

/**
 * P2.1 + P2.2 loop tests (docs/migration/typescript-core/loop-and-state.md §"一回合精确时序").
 *
 * The pure-answer fixture (P2.1) is the tool-free contract; the tool-round-trip
 * fixture (P2.2) is the primary tool-phase contract: a model tool call is
 * validated, executed via the injected executor, its observation appended as a
 * ToolResultMessage, then the model is called again and answers. Expected values
 * come from the C# baseline tests at 09f4e08 — never from generated TS output.
 * The fixture's scripted model yields exactly one `completed` per call (the
 * non-streaming semantics the fixtures' eventSequence assumes); delta forwarding
 * is exercised by a separate streaming model.
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
  private readonly fallback_: ModelStepJson | undefined;
  private callIndex_ = 0;

  constructor(script: ModelScriptJson) {
    this.responses_ = script.responses;
    this.fallback_ = script.fallback;
  }

  get callCount(): number {
    return this.callIndex_;
  }

  stream(request: ModelRequest, _signal?: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    // A fixture may script zero responses and rely on `fallback` (hard-cancel.json),
    // which then serves every model call.
    const step = this.responses_[this.callIndex_] ?? this.fallback_;
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

/** A RecordingExecutor whose canned observations come from the fixture's expected tool calls. */
function cannedExecutor(fixture: LoopFixture): RecordingExecutor {
  const canned = new Map<string, ToolObservation>();
  for (const expected of fixture.expected.toolCalls) {
    canned.set(expected.id, { text: expected.observation, isError: expected.isError });
  }
  return new RecordingExecutor((call) => canned.get(call.id) ?? { text: "unexpected call", isError: true });
}

/** One scripted completed response with the given text / tool calls and zero usage. */
function step(text: string | null, toolCalls: readonly { id: string; name: string; arguments: string }[]): ModelStepJson {
  return {
    text,
    toolCalls,
    finishReason: toolCalls.length > 0 ? "tool-calls" : "stop",
    failure: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    cost: null,
    model: "fake",
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

test("tool-round-trip fixture: a tool call executes, its observation is appended, and the loop answers", async () => {
  const fixture = loadLoopFixture("tool-round-trip.json");
  const model = new ScriptedModel(fixture.input.model);
  const events: AgentEvent[] = [];
  const executor = cannedExecutor(fixture);

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
  assert.deepEqual(
    events.map((event) => event.type),
    fixture.expected.eventSequence,
  );
  assert.deepEqual(
    executor.records(),
    fixture.expected.toolCalls.map((call, index) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      order: index + 1,
    })),
  );
  assert.equal(result.trajectory.length, fixture.expected.trajectoryCount);
  assert.deepEqual(result.trajectory, fixture.expected.trajectory);
});

test("multiple tool calls in one turn execute in order and are all appended", async () => {
  const model = new ScriptedModel({
    responses: [
      step("need both", [
        { id: "c1", name: "echo", arguments: "{\"v\":1}" },
        { id: "c2", name: "echo", arguments: "{\"v\":2}" },
      ]),
      step("summed", []),
    ],
  });
  const executor = new RecordingExecutor((call) => ({ text: call.arguments, isError: false }));

  const result = await runAgentLoop(
    { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "go", history: [], tools: [] },
    { model, toolExecutor: executor, estimateRequestTokens: () => 0 },
  );

  assert.equal(result.stopReason, "answer");
  assert.equal(result.iterations, 2);
  assert.deepEqual(executor.records(), [
    { id: "c1", name: "echo", arguments: "{\"v\":1}", order: 1 },
    { id: "c2", name: "echo", arguments: "{\"v\":2}", order: 2 },
  ]);
  assert.equal(result.trajectory.length, 5); // [user, assistant, tool, tool, assistant]
  const secondTool = result.trajectory[3];
  assert.ok(secondTool, "expected a tool message at index 3");
  assert.equal(secondTool.role, "tool");
  if (secondTool.role === "tool") {
    assert.equal(secondTool.toolCallId, "c2");
    assert.equal(secondTool.content, "{\"v\":2}");
  }
});

test("a throwing tool becomes an isError observation and the loop continues", async () => {
  const model = new ScriptedModel({
    responses: [step("will call", [{ id: "c1", name: "boom", arguments: "{}" }]), step("recovered", [])],
  });
  const executor = new RecordingExecutor(() => {
    throw new Error("kaboom");
  });

  const result = await runAgentLoop(
    { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "go", history: [], tools: [] },
    { model, toolExecutor: executor, estimateRequestTokens: () => 0 },
  );

  assert.equal(result.stopReason, "answer");
  assert.equal(result.iterations, 2);
  const tool = result.trajectory[2];
  assert.ok(tool, "expected a tool message at index 2");
  assert.equal(tool.role, "tool");
  if (tool.role === "tool") {
    assert.equal(tool.isError, true);
    assert.match(tool.content, /error executing tool 'boom'/);
    assert.match(tool.content, /kaboom/);
  }
});

test("toolValidator is invoked before execution", async () => {
  const model = new ScriptedModel({
    responses: [step("x", [{ id: "c1", name: "echo", arguments: "{}" }]), step("done", [])],
  });
  const validated: ToolCall[] = [];
  const executor = new RecordingExecutor((call) => ({ text: "ok", isError: false }));
  const validator: ToolValidator = {
    validate(call: ToolCall) {
      validated.push(call);
    },
  };

  const result = await runAgentLoop(
    { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "go", history: [], tools: [] },
    { model, toolExecutor: executor, toolValidator: validator, estimateRequestTokens: () => 0 },
  );

  assert.equal(result.stopReason, "answer");
  assert.deepEqual(validated.map((call) => call.name), ["echo"]);
  assert.equal(executor.calls.length, 1, "a validated call must be executed");
});

test("a rejecting toolValidator aborts the run before the tool executes", async () => {
  const model = new ScriptedModel({
    responses: [step("x", [{ id: "c1", name: "echo", arguments: "{}" }])],
  });
  const executor = new RecordingExecutor((call) => ({ text: "ok", isError: false }));
  const rejecting: ToolValidator = {
    validate() {
      throw new Error("not allowed");
    },
  };

  await assert.rejects(
    runAgentLoop(
      { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "go", history: [], tools: [] },
      { model, toolExecutor: executor, toolValidator: rejecting, estimateRequestTokens: () => 0 },
    ),
    /not allowed/,
  );
  assert.equal(executor.calls.length, 0, "a rejected call must never execute");
});

test("beforeToolExecution is called with the trajectory before the tool runs", async () => {
  const model = new ScriptedModel({
    responses: [step("x", [{ id: "c1", name: "echo", arguments: "{}" }]), step("done", [])],
  });
  const executor = new RecordingExecutor((call) => ({ text: "ok", isError: false }));
  let observedTrajectory: readonly AgentMessage[] | undefined;

  const result = await runAgentLoop(
    { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "go", history: [], tools: [] },
    {
      model,
      toolExecutor: executor,
      estimateRequestTokens: () => 0,
      beforeToolExecution: (trajectory) => {
        // Snapshot: the loop mutates the same array in place as it continues.
        observedTrajectory = [...trajectory];
      },
    },
  );

  assert.equal(result.stopReason, "answer");
  assert.ok(observedTrajectory, "beforeToolExecution must be invoked");
  assert.equal(observedTrajectory.length, 2, "hook sees [user, assistant(tool-call)] before the tool runs");
  assert.equal(executor.calls.length, 1);
});

test("a throwing beforeToolExecution aborts the run before the tool executes", async () => {
  const model = new ScriptedModel({
    responses: [step("x", [{ id: "c1", name: "echo", arguments: "{}" }])],
  });
  const executor = new RecordingExecutor((call) => ({ text: "ok", isError: false }));

  await assert.rejects(
    runAgentLoop(
      { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "go", history: [], tools: [] },
      {
        model,
        toolExecutor: executor,
        estimateRequestTokens: () => 0,
        beforeToolExecution: () => {
          throw new Error("hook blocked");
        },
      },
    ),
    /hook blocked/,
  );
  assert.equal(executor.calls.length, 0, "the tool must never run when the pre-execution hook throws");
});

test("checkpoint.toolStarted failure prevents tool execution", async () => {
  const model = new ScriptedModel({
    responses: [step("work", [{ id: "c1", name: "danger", arguments: "{}" }])],
  });
  const executor = new RecordingExecutor((call) => ({ text: "ran", isError: false }));
  const checkpoint: LoopCheckpoint = {
    appendMessage: () => {},
    toolStarted: () => {
      throw new Error("disk full");
    },
    toolCompleted: () => {},
  };

  await assert.rejects(
    runAgentLoop(
      { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "do it", history: [], tools: [] },
      { model, toolExecutor: executor, estimateRequestTokens: () => 0, checkpoint },
    ),
    /disk full/,
  );
  assert.equal(executor.calls.length, 0, "the tool must never run when the intent checkpoint fails");
});

test("checkpoint and observer see toolStarted before toolCompleted around the execution", async () => {
  const model = new ScriptedModel({
    responses: [step("x", [{ id: "c1", name: "echo", arguments: "{}" }]), step("done", [])],
  });
  const executor = new RecordingExecutor((call) => ({ text: "ok", isError: false }));
  const checkpointOrder: string[] = [];
  const checkpoint: LoopCheckpoint = {
    appendMessage: () => {
      checkpointOrder.push("appendMessage");
    },
    toolStarted: () => {
      checkpointOrder.push("toolStarted");
    },
    toolCompleted: () => {
      checkpointOrder.push("toolCompleted");
    },
  };
  const events: AgentEvent[] = [];

  const result = await runAgentLoop(
    { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "go", history: [], tools: [] },
    {
      model,
      toolExecutor: executor,
      estimateRequestTokens: () => 0,
      checkpoint,
      events: (event) => {
        events.push(event);
      },
    },
  );

  assert.equal(result.stopReason, "answer");
  assert.deepEqual(checkpointOrder, ["appendMessage", "toolStarted", "toolCompleted", "appendMessage"]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["turnCompleted", "toolStarted", "toolCompleted", "turnCompleted"],
  );
});

test("finalOutputTool returns the raw arguments as the answer without executing", async () => {
  const model = new ScriptedModel({
    responses: [step("finishing", [{ id: "f1", name: "finish", arguments: "{\"answer\":\"42\"}" }])],
  });
  const executor = new RecordingExecutor((call) => ({ text: "should not run", isError: false }));

  const result = await runAgentLoop(
    {
      sessionId: "s1",
      systemPrompt: "test system prompt",
      userMessage: "go",
      history: [],
      tools: [],
      finalOutputTool: "finish",
    },
    { model, toolExecutor: executor, estimateRequestTokens: () => 0 },
  );

  assert.equal(result.stopReason, "final_output_tool");
  assert.equal(result.answer, "{\"answer\":\"42\"}");
  assert.equal(result.iterations, 1);
  assert.equal(executor.calls.length, 0);
});

test("maxIterations stops the loop and does not execute tools on the final turn", async () => {
  const model = new ScriptedModel({
    responses: [step("still working", [{ id: "c1", name: "echo", arguments: "{}" }]),
      step("still working", [{ id: "c2", name: "echo", arguments: "{}" }]),
      step("still working", [{ id: "c3", name: "echo", arguments: "{}" }])],
  });
  const executor = new RecordingExecutor((call) => ({ text: "x", isError: false }));

  const result = await runAgentLoop(
    { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "go", history: [], tools: [], maxIterations: 3 },
    { model, toolExecutor: executor, estimateRequestTokens: () => 0 },
  );

  assert.equal(result.stopReason, "max_iterations");
  assert.equal(result.iterations, 3);
  assert.equal(executor.calls.length, 2, "the first two rounds execute; the third round's tools must not run");
});

test("usage accumulates across the tool round-trip model calls", async () => {
  const model = new ScriptedModel({
    responses: [
      {
        text: "need",
        toolCalls: [{ id: "c1", name: "echo", arguments: "{}" }],
        finishReason: "tool-calls",
        failure: null,
        usage: { inputTokens: 10, outputTokens: 5 },
        cost: null,
        model: "fake",
      },
      {
        text: "done",
        toolCalls: [],
        finishReason: "stop",
        failure: null,
        usage: { inputTokens: 20, outputTokens: 7 },
        cost: null,
        model: "fake",
      },
    ],
  });
  const executor = new RecordingExecutor((call) => ({ text: "ok", isError: false }));

  const result = await runAgentLoop(
    { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "go", history: [], tools: [] },
    { model, toolExecutor: executor, estimateRequestTokens: () => 0 },
  );

  assert.equal(result.iterations, 2);
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 12 });
});

// ---------------------------------------------------------------------------
// P2.3 context-budget guard and iteration boundaries
// (loop-and-state.md §"一回合精确时序" step 3 + §"iteration 与停止理由")
// ---------------------------------------------------------------------------

test("budget-pause fixture: an estimate over the budget pauses with context_limit before any model call", async () => {
  const fixture = loadLoopFixture("budget-pause.json");
  const model = new ScriptedModel(fixture.input.model);
  const events: AgentEvent[] = [];
  const executor = new RecordingExecutor(() => ({ text: "unexpected tool call", isError: true }));

  const result = await runAgentLoop(toAgentRequest(fixture), {
    model,
    toolExecutor: executor,
    // The host-provided estimate exceeds contextTokenBudget(1) on the first request.
    estimateRequestTokens: () => 1_000_000,
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
  assert.equal(executor.calls.length, 0, "the budget guard must not execute tools");
  assert.deepEqual(
    events.map((event) => event.type),
    fixture.expected.eventSequence,
  );
  assert.equal(result.trajectory.length, fixture.expected.trajectoryCount);
  assert.deepEqual(result.trajectory, fixture.expected.trajectory);
});

test("contextTokenBudget of 0 pauses unconditionally even with a zero estimate", async () => {
  const model = new ScriptedModel({
    responses: [step("should never be reached", [])],
  });
  const executor = new RecordingExecutor(() => ({ text: "unexpected tool call", isError: true }));

  const result = await runAgentLoop(
    {
      sessionId: "s1",
      systemPrompt: "test system prompt",
      userMessage: "tiny",
      history: [],
      tools: [],
      contextTokenBudget: 0,
    },
    { model, toolExecutor: executor, estimateRequestTokens: () => 0 },
  );

  assert.equal(result.stopReason, "context_limit");
  assert.equal(result.iterations, 0);
  assert.equal(model.callCount, 0);
  assert.deepEqual(result.trajectory, [{ role: "user", content: [{ type: "text", text: "tiny" }] }]);
});

test("an estimate exactly equal to the budget proceeds; only an over-budget estimate pauses", async () => {
  const model = new ScriptedModel({
    responses: [step("ok", [])],
  });

  const result = await runAgentLoop(
    {
      sessionId: "s1",
      systemPrompt: "test system prompt",
      userMessage: "hi",
      history: [],
      tools: [],
      contextTokenBudget: 3,
    },
    { model, toolExecutor: new RecordingExecutor(() => ({ text: "unexpected", isError: true })), estimateRequestTokens: () => 3 },
  );

  assert.equal(result.stopReason, "answer");
  assert.equal(result.answer, "ok");
  assert.equal(model.callCount, 1);
});

test("without a contextTokenBudget the estimate guard is disabled", async () => {
  const model = new ScriptedModel({
    responses: [step("ok", [])],
  });

  const result = await runAgentLoop(
    { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "hi", history: [], tools: [] },
    { model, toolExecutor: new RecordingExecutor(() => ({ text: "unexpected", isError: true })), estimateRequestTokens: () => 1_000_000 },
  );

  assert.equal(result.stopReason, "answer");
  assert.equal(result.answer, "ok");
  assert.equal(model.callCount, 1);
});

test("estimate over the budget on a later loop iteration pauses with trajectory and usage preserved", async () => {
  const model = new ScriptedModel({
    responses: [
      step("still working", [{ id: "c1", name: "echo", arguments: "{}" }]),
      // A second model call must never happen.
    ],
  });
  const executor = new RecordingExecutor((call) => ({ text: "ok", isError: false }));

  const result = await runAgentLoop(
    {
      sessionId: "s1",
      systemPrompt: "test system prompt",
      userMessage: "go",
      history: [],
      tools: [],
      contextTokenBudget: 1,
    },
    {
      model,
      toolExecutor: executor,
      // The first request fits; once the tool result grows the trajectory the next request overflows.
      estimateRequestTokens: (request) => (request.messages.length > 2 ? 1_000_000 : 0),
    },
  );

  assert.equal(result.stopReason, "context_limit");
  assert.equal(result.answer, "still working");
  assert.equal(result.iterations, 1);
  assert.equal(model.callCount, 1, "the second model call must be blocked by the budget guard");
  assert.equal(executor.calls.length, 1);
  assert.equal(result.trajectory.length, 3); // [user, assistant(tool-call), tool result]
});

test("context_limit answer never returns an old history assistant text", async () => {
  const history = [
    { role: "user", content: [{ type: "text", text: "previous question" }] },
    { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
  ];
  const model = new ScriptedModel({ responses: [] }); // never reached
  const executor = new RecordingExecutor(() => ({ text: "unexpected", isError: true }));

  const result = await runAgentLoop(
    {
      sessionId: "s1",
      systemPrompt: "test system prompt",
      userMessage: "large current task",
      history: history as unknown as AgentRequest["history"],
      tools: [],
      contextTokenBudget: 1,
    },
    { model, toolExecutor: executor, estimateRequestTokens: () => 1_000_000 },
  );

  assert.equal(result.stopReason, "context_limit");
  assert.equal(result.answer, "");
  assert.equal(model.callCount, 0);
});

test("the budget estimator sees the exact model request the model receives", async () => {
  const model = new ScriptedModel({
    responses: [step("ok", [])],
  });
  let estimated: ModelRequest | undefined;

  await runAgentLoop(
    {
      sessionId: "s1",
      systemPrompt: "test system prompt",
      userMessage: "hi",
      history: [],
      tools: [],
      contextTokenBudget: 1000,
    },
    {
      model,
      toolExecutor: new RecordingExecutor(() => ({ text: "unexpected", isError: true })),
      estimateRequestTokens: (request) => {
        estimated = request;
        return 1;
      },
    },
  );

  assert.ok(estimated, "the estimator must be invoked for an over-zero budget");
  assert.deepEqual(estimated.messages, [
    { role: "system", text: "test system prompt" },
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ]);
  const sent = model.requests[0];
  assert.ok(sent, "expected one model request");
  assert.equal(sent, estimated, "the estimator and the model must share the same request (same order and tools)");
});

test("without maxIterations the loop is unlimited (continues past 24 tool rounds)", async () => {
  let calls = 0;
  const model: ChatModel = {
    stream(): AsyncIterable<ModelEvent> {
      calls += 1;
      const current = step(
        calls < 25 ? "still working" : "done",
        calls < 25 ? [{ id: `c${calls}`, name: "echo", arguments: "{}" }] : [],
      );
      const response: ModelResponse = {
        message: { role: "assistant", content: assistantContent(current) },
        finishReason: toFinishReason(current.finishReason),
        usage: { ...current.usage },
        model: current.model,
        timestamp: FIXED_TIMESTAMP,
      };
      return (async function* (): AsyncGenerator<ModelEvent> {
        yield { type: "completed", response };
      })();
    },
  };
  const executor = new RecordingExecutor((call) => ({ text: "ok", isError: false }));

  const result = await runAgentLoop(
    { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "go", history: [], tools: [] },
    { model, toolExecutor: executor, estimateRequestTokens: () => 0 },
  );

  assert.equal(result.stopReason, "answer");
  assert.equal(result.iterations, 25);
  assert.equal(calls, 25, "the default must not impose an iteration cap");
  assert.equal(executor.calls.length, 24, "all but the final round execute their tool");
});

test("maxIterations=1 makes a single model call and does not execute its tools", async () => {
  const model = new ScriptedModel({
    responses: [step("first", [{ id: "c1", name: "echo", arguments: "{}" }])],
  });
  const executor = new RecordingExecutor((call) => ({ text: "x", isError: false }));

  const result = await runAgentLoop(
    {
      sessionId: "s1",
      systemPrompt: "test system prompt",
      userMessage: "go",
      history: [],
      tools: [],
      maxIterations: 1,
    },
    { model, toolExecutor: executor, estimateRequestTokens: () => 0 },
  );

  assert.equal(result.stopReason, "max_iterations");
  assert.equal(result.iterations, 1);
  assert.equal(executor.calls.length, 0, "the final round's tools must not execute");
});

test("a single round with multiple tools respects the iteration cap (no tools run on the final round)", async () => {
  const model = new ScriptedModel({
    responses: [
      step("round one", [
        { id: "c1", name: "echo", arguments: "{}" },
        { id: "c2", name: "echo", arguments: "{}" },
      ]),
    ],
  });
  const executor = new RecordingExecutor((call) => ({ text: "x", isError: false }));

  const result = await runAgentLoop(
    {
      sessionId: "s1",
      systemPrompt: "test system prompt",
      userMessage: "go",
      history: [],
      tools: [],
      maxIterations: 1,
    },
    { model, toolExecutor: executor, estimateRequestTokens: () => 0 },
  );

  assert.equal(result.stopReason, "max_iterations");
  assert.equal(result.iterations, 1);
  assert.equal(executor.calls.length, 0, "neither tool may run on the final (capped) round");
});

// ---------------------------------------------------------------------------
// P2.4 soft-stop and hard-cancel
// (loop-and-state.md §"中断、取消与并发生命周期"; C# ReActInterruptTests at
// 09f4e08 — StopRequested_AfterModelProducedToolCalls_DoesNotExecuteTools,
// StopRequested_BeforeFirstModelCall_ReturnsInterruptedWithoutCallingModel,
// StopRequested_AfterToolBatch_StopsBeforeNextModelCall)
// ---------------------------------------------------------------------------

test("soft-stop fixture: an interrupt request after the model returns tool calls stops before any tool runs", async () => {
  const fixture = loadLoopFixture("soft-stop.json");
  const model = new ScriptedModel(fixture.input.model);
  const events: AgentEvent[] = [];
  const executor = new RecordingExecutor(() => ({ text: "must not run", isError: false }));
  const stopAfterTurn = fixture.input.interrupt?.softStopAfterTurn;
  let softStopRequested = false;

  const result = await runAgentLoop(toAgentRequest(fixture), {
    model,
    toolExecutor: executor,
    estimateRequestTokens: () => 0,
    events: (event) => {
      events.push(event);
      // The soft stop arrives right after the model produced tool calls (B1).
      if (stopAfterTurn !== undefined && event.type === "turnCompleted" && event.iteration === stopAfterTurn) {
        softStopRequested = true;
      }
    },
    interruptRequested: () => softStopRequested,
  });

  assert.equal(result.stopReason, fixture.expected.stopReason);
  assert.equal(result.answer, fixture.expected.answer);
  assert.equal(result.iterations, fixture.expected.iterations);
  assert.deepEqual(result.usage, fixture.expected.usage);
  assert.equal(result.cost ?? null, fixture.expected.cost);
  assert.equal(result.failure ?? null, fixture.expected.failure);
  assert.equal(model.callCount, fixture.expected.modelRequestCount, "no further model call after the soft stop");
  assert.deepEqual(
    events.map((event) => event.type),
    fixture.expected.eventSequence,
  );
  assert.deepEqual(executor.records(), [], "no tool may start after the soft stop");
  assert.equal(result.trajectory.length, fixture.expected.trajectoryCount);
  assert.deepEqual(result.trajectory, fixture.expected.trajectory);
});

test("a soft stop at loop top returns interrupted before the context guard or any model call", async () => {
  const model = new ScriptedModel({ responses: [step("should never be reached", [])] });
  const events: AgentEvent[] = [];
  let estimateCalls = 0;
  const executor = new RecordingExecutor(() => ({ text: "must not run", isError: false }));

  const result = await runAgentLoop(
    {
      sessionId: "s1",
      systemPrompt: "test system prompt",
      userMessage: "hi",
      history: [],
      tools: [],
      contextTokenBudget: 1000,
    },
    {
      model,
      toolExecutor: executor,
      estimateRequestTokens: () => {
        estimateCalls += 1;
        return 0;
      },
      events: (event) => {
        events.push(event);
      },
      interruptRequested: () => true,
    },
  );

  assert.equal(result.stopReason, "interrupted");
  assert.equal(result.answer, "", "no assistant message has been produced yet");
  assert.equal(result.iterations, 0);
  assert.equal(model.callCount, 0, "a loop-top soft stop must not call the model");
  assert.equal(estimateCalls, 0, "the soft stop precedes the context guard");
  assert.equal(executor.calls.length, 0, "no tool may run");
  assert.deepEqual(events.map((event) => event.type), ["interrupted"]);
  assert.deepEqual(result.trajectory, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("a soft stop requested during tool execution lets the running tool complete, then interrupts before the next model call", async () => {
  const model = new ScriptedModel({
    responses: [
      step("need data", [{ id: "c1", name: "echo", arguments: "{}" }]),
      step("should never be reached", []),
    ],
  });
  const events: AgentEvent[] = [];
  let softStopRequested = false;
  const executor = new RecordingExecutor((call) => {
    softStopRequested = true; // the request arrives while the tool runs (B2)
    return { text: "tool result", isError: false };
  });

  const result = await runAgentLoop(
    { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "hello", history: [], tools: [] },
    {
      model,
      toolExecutor: executor,
      estimateRequestTokens: () => 0,
      events: (event) => {
        events.push(event);
      },
      interruptRequested: () => softStopRequested,
    },
  );

  assert.equal(result.stopReason, "interrupted");
  assert.equal(result.answer, "need data");
  assert.equal(result.iterations, 1);
  assert.equal(model.callCount, 1, "the next model call must be blocked by the loop-top soft stop");
  assert.deepEqual(executor.records(), [{ id: "c1", name: "echo", arguments: "{}", order: 1 }]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["turnCompleted", "toolStarted", "toolCompleted", "interrupted"],
  );
  assert.equal(result.trajectory.length, 3); // [user, assistant(tool-call), tool result]
  const tool = result.trajectory[2];
  assert.ok(tool, "expected a tool message at index 2");
  assert.equal(tool.role, "tool");
});

test("hard-cancel fixture: an abort after the tool completes rejects with AbortError and preserves the tool observation", async () => {
  const fixture = loadLoopFixture("hard-cancel.json");
  const model = new ScriptedModel(fixture.input.model);
  const events: AgentEvent[] = [];
  const recorded: AgentMessage[] = [];
  const checkpoint: LoopCheckpoint = {
    appendMessage: (message) => {
      recorded.push(message);
    },
    toolStarted: () => {},
    toolCompleted: (result) => {
      recorded.push(result);
    },
  };
  const controller = new AbortController();
  const executor = new RecordingExecutor((call) => {
    if (fixture.input.interrupt?.cancelAfterTool === true) {
      controller.abort();
    }
    return { text: "done", isError: false };
  });

  await assert.rejects(
    runAgentLoop(
      toAgentRequest(fixture),
      {
        model,
        toolExecutor: executor,
        estimateRequestTokens: () => 0,
        checkpoint,
        events: (event) => {
          events.push(event);
        },
      },
      controller.signal,
    ),
    (error: unknown) => (error as { name?: string }).name === "AbortError",
  );

  assert.equal(model.callCount, fixture.expected.modelRequestCount);
  assert.deepEqual(
    events.map((event) => event.type),
    fixture.expected.eventSequence,
  );
  assert.deepEqual(
    executor.records(),
    fixture.expected.toolCalls.map((call, index) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      order: index + 1,
    })),
  );
  // A rejection has no returned trajectory; the checkpointed messages document
  // the observable partial state: trajectory after the leading user message.
  const expectedTrajectory = fixture.expected.trajectory;
  assert.ok(expectedTrajectory, "hard-cancel fixture carries an expected trajectory");
  assert.deepEqual(recorded, expectedTrajectory.slice(1), "the completed tool observation is preserved");
});

test("an abort while the model stream is in progress rejects with AbortError", async () => {
  const controller = new AbortController();
  const model: ChatModel = {
    stream(_request, signal) {
      return (async function* (): AsyncGenerator<ModelEvent> {
        yield { type: "textDelta", delta: "par" };
        controller.abort();
        signal?.throwIfAborted();
      })();
    },
  };
  const events: AgentEvent[] = [];

  await assert.rejects(
    runAgentLoop(
      { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "hi", history: [], tools: [] },
      {
        model,
        toolExecutor: new RecordingExecutor(() => ({ text: "never", isError: false })),
        estimateRequestTokens: () => 0,
        events: (event) => {
          events.push(event);
        },
      },
      controller.signal,
    ),
    (error: unknown) => (error as { name?: string }).name === "AbortError",
  );

  assert.deepEqual(events.map((event) => event.type), ["textDelta"], "abort before completed yields no turnCompleted");
});

test("an AbortError thrown by a tool propagates as a rejection, never an isError observation", async () => {
  const model = new ScriptedModel({
    responses: [step("will call", [{ id: "c1", name: "long", arguments: "{}" }])],
  });
  const events: AgentEvent[] = [];
  const executor = new RecordingExecutor(() => {
    throw Object.assign(new Error("canceled by host"), { name: "AbortError" });
  });

  await assert.rejects(
    runAgentLoop(
      { sessionId: "s1", systemPrompt: "test system prompt", userMessage: "go", history: [], tools: [] },
      {
        model,
        toolExecutor: executor,
        estimateRequestTokens: () => 0,
        events: (event) => {
          events.push(event);
        },
      },
    ),
    (error: unknown) => (error as { name?: string }).name === "AbortError",
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["turnCompleted", "toolStarted"],
    "toolStarted fires, but an AbortError must never surface as a toolCompleted error observation",
  );
});
