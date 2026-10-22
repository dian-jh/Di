import test from "node:test";
import assert from "node:assert/strict";

import type {
  AgentMessage,
  ChatModel,
  ContentBlock,
  ModelEvent,
  ModelRequest,
  ModelResponse,
  TokenUsage,
  ToolCall,
  UsageCost,
} from "@di/ai";
import { textOfMessage } from "@di/ai";
import type { ToolExecutor, ToolObservation } from "@di/agent";
import {
  AgentSession,
  InputBudgetTracker,
  SessionBusyError,
  buildEnvironmentSnapshot,
  estimateMemoryTokens,
  sanitizeHistory,
  trimHistoryByTokens,
} from "@di/coding-agent";

/**
 * P2.6 card 6 + P2.7 card 7 (model switching): cross-turn history, environment
 * snapshot, the budget tracker and the model-resolution / usage-cost ledger — the
 * `AgentSession` host (docs/migration/typescript-core/loop-and-state.md
 * §"模型与 Skills 切换" / §"预算、成本与 usage 记账"; C# baseline
 * `Core/AgentLoop/AgentRunner.cs` `RunAsync` / `_modelFactory` +
 * `Core/Llm/LlmRuntime.cs` `ResolveModelAsync` / `CalculateCost`).
 *
 * Every business case is red by ASSERTION (never a path / missing-export error):
 * turn A's trajectory appears in turn B's history; whole user-turn trim keeps the
 * most recent turn; unpaired tool calls are sanitized in persisted history while
 * the result trajectory is NOT rewritten; a `context_limit` pause preserves the
 * trajectory until reset; the stable snapshot is appended only when changed;
 * concurrent prompt/reset is rejected per the busy policy; the budget tracker
 * sees the accumulated trajectory before tool execution plus the trimmed estimate
 * at turn end; a swapped model takes effect at the next turn boundary with A+B
 * usage/cost accumulated in the session ledger; a mid-turn `setModel` keeps the
 * running turn on the old model stream without polluting the ledger; a model
 * resolution failure rejects at the turn boundary with an explicit error and
 * does not disturb committed history; and no model window invents no token limit.
 */

/** One canned model step: an assistant text and/or tool calls, plus optional reported usage/cost. */
interface Step {
  text: string;
  toolCalls?: readonly { id: string; name: string; arguments: string }[];
  usage?: TokenUsage;
  cost?: UsageCost;
}

/** Scripted ChatModel yielding exactly one `completed` per call; repeats the last step. */
class FakeModel implements ChatModel {
  readonly requests: ModelRequest[] = [];
  private readonly steps_: readonly Step[];
  private index_ = 0;

  constructor(steps: readonly Step[]) {
    if (steps.length === 0) throw new Error("FakeModel: at least one step required");
    this.steps_ = steps;
  }

  get callCount(): number {
    return this.index_;
  }

  stream(request: ModelRequest, _signal?: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const step = this.steps_[Math.min(this.index_, this.steps_.length - 1)]!;
    this.index_ += 1;
    const response: ModelResponse = {
      message: { role: "assistant", content: assistantContent(step) },
      finishReason: (step.toolCalls?.length ?? 0) > 0 ? { type: "tool-calls" } : { type: "stop" },
      usage: step.usage ?? { inputTokens: 0, outputTokens: 0 },
      ...(step.cost !== undefined ? { cost: step.cost } : {}),
      model: "fake",
      timestamp: 1_700_000_000_000,
    };
    return (async function* (): AsyncGenerator<ModelEvent> {
      yield { type: "completed", response };
    })();
  }
}

function assistantContent(step: Step): readonly ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: "text", text: step.text }];
  for (const call of step.toolCalls ?? []) {
    blocks.push({ type: "tool-call", id: call.id, name: call.name, arguments: call.arguments });
  }
  return blocks;
}

/** Records calls, returns a canned result; optionally observes the budget tracker. */
class FakeExecutor implements ToolExecutor {
  readonly calls: ToolCall[] = [];
  private readonly observer_?: () => void;

  constructor(observer?: () => void) {
    this.observer_ = observer;
  }

  execute(call: ToolCall, _signal?: AbortSignal): Promise<ToolObservation> {
    this.calls.push(call);
    this.observer_?.();
    return Promise.resolve({ text: `result ${call.name}`, isError: false });
  }
}

/** A ChatModel that blocks on a gate until the test releases it (busy tests). */
class GatedModel implements ChatModel {
  private release_: () => void = () => {};
  private readonly gate_: Promise<void>;
  private readonly usage_: TokenUsage;

  constructor(usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }) {
    this.gate_ = new Promise<void>((resolve) => {
      this.release_ = resolve;
    });
    this.usage_ = usage;
  }

  release(): void {
    this.release_();
  }

  async *stream(_request: ModelRequest, _signal?: AbortSignal): AsyncIterable<ModelEvent> {
    await this.gate_;
    yield {
      type: "completed",
      response: {
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        finishReason: { type: "stop" },
        usage: this.usage_,
        model: "fake",
        timestamp: 1_700_000_000_000,
      },
    };
  }
}

function isBusy(error: unknown): boolean {
  return error instanceof SessionBusyError;
}

/**
 * Assert that `promise` rejects with a matching error within `timeoutMs`.
 * Bounded so a missing busy check fails cleanly (red) instead of hanging on the
 * gate the first turn is blocked on.
 */
async function rejectsWithin(
  promise: Promise<unknown>,
  predicate: (error: unknown) => boolean,
  timeoutMs: number,
): Promise<void> {
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`expected a rejection within ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([promise, timeout]);
    throw new Error("expected the call to be rejected, but it resolved");
  } catch (error) {
    if (!timedOut && predicate(error)) return;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Cross-turn history
// ---------------------------------------------------------------------------

test("turn A's trajectory appears in turn B's history (cross-turn memory)", async () => {
  const model = new FakeModel([{ text: "answer-甲" }, { text: "answer-乙" }]);
  const session = new AgentSession(
    { systemPrompt: "sys", tokenBudget: 10_000 },
    { model, toolExecutor: new FakeExecutor(), estimateRequestTokens: () => 1 },
  );
  const resultA = await session.runTurn({ userMessage: "甲" });
  assert.equal(resultA.stopReason, "answer");
  const resultB = await session.runTurn({ userMessage: "乙" });
  // The history passed into turn B is turn A's full trajectory (user + assistant).
  assert.deepEqual(
    resultB.history.map((message) => textOfMessage(message)),
    ["甲", "answer-甲"],
  );
});

test("whole user-turn trim drops oldest turns and keeps the most recent turn", async () => {
  const longAnswer = (n: number): string => "x".repeat(n); // 396 chars = 99 tokens
  const model = new FakeModel([{ text: longAnswer(396) }, { text: longAnswer(396) }, { text: "done" }]);
  const session = new AgentSession(
    { systemPrompt: "sys", tokenBudget: 150 },
    { model, toolExecutor: new FakeExecutor(), estimateRequestTokens: () => 1 },
  );
  await session.runTurn({ userMessage: "甲" });
  await session.runTurn({ userMessage: "乙" });
  const third = await session.runTurn({ userMessage: "丙" });
  const userTexts = third.history.filter((m) => m.role === "user").map((m) => textOfMessage(m));
  assert.deepEqual(userTexts, ["乙"], "oldest whole user-turn is dropped");
  assert.ok(
    !third.history.some((m) => textOfMessage(m).includes("甲")),
    "trimming is whole-turn only, never a partial cut",
  );
});

test("no token budget and no maxHistoryTurns keeps full history (no invented limit)", async () => {
  const model = new FakeModel([{ text: "a1" }, { text: "a2" }, { text: "a3" }]);
  const session = new AgentSession(
    { systemPrompt: "sys" }, // no tokenBudget, no maxHistoryTurns
    { model, toolExecutor: new FakeExecutor(), estimateRequestTokens: () => 1 },
  );
  await session.runTurn({ userMessage: "甲" });
  await session.runTurn({ userMessage: "乙" });
  const third = await session.runTurn({ userMessage: "丙" });
  assert.deepEqual(
    third.history.filter((m) => m.role === "user").map((m) => textOfMessage(m)),
    ["甲", "乙"],
  );
});

// ---------------------------------------------------------------------------
// Sanitize / context_limit
// ---------------------------------------------------------------------------

test("unpaired tool calls are sanitized in persisted history; the result trajectory is NOT rewritten", async () => {
  const model = new FakeModel([
    { text: "let me check", toolCalls: [{ id: "c1", name: "read", arguments: "{}" }] },
    { text: "done" },
  ]);
  const executor = new FakeExecutor();
  const session = new AgentSession(
    { systemPrompt: "sys", tokenBudget: 10_000 },
    { model, toolExecutor: executor, estimateRequestTokens: () => 1 },
  );
  const resultA = await session.runTurn({ userMessage: "甲", maxIterations: 1 });
  assert.equal(resultA.stopReason, "max_iterations");
  assert.equal(executor.calls.length, 0, "the capped turn must not execute its tool calls");
  // The returned result trajectory is the full loop trajectory, never rewritten.
  assert.ok(
    resultA.trajectory.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "tool-call")),
  );

  const resultB = await session.runTurn({ userMessage: "乙" });
  // Persisted history: the orphaned tool-call assistant is gone, the user turn remains.
  assert.ok(
    !resultB.history.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "tool-call")),
    "the orphaned tool-call group is removed from persisted memory",
  );
  assert.deepEqual(
    resultB.history.filter((m) => m.role === "user").map((m) => textOfMessage(m)),
    ["甲"],
  );
});

test("after context_limit the paused trajectory is preserved: the next turn does not auto-trim it", async () => {
  const model = new FakeModel([{ text: "ok" }, { text: "never" }, { text: "never" }]);
  const estimate = (request: ModelRequest): number => request.messages.length;
  const session = new AgentSession(
    { systemPrompt: "sys", tokenBudget: 2 },
    { model, toolExecutor: new FakeExecutor(), estimateRequestTokens: estimate },
  );
  await session.runTurn({ userMessage: "甲" }); // 2 messages == budget -> runs
  const paused = await session.runTurn({ userMessage: "乙" }); // 4 messages > budget -> context_limit
  assert.equal(paused.stopReason, "context_limit");
  assert.equal(model.callCount, 1, "no model call for the paused turn");
  const third = await session.runTurn({ userMessage: "丙" });
  // The full paused trajectory (both turns) is still there — no auto-trim, no summary.
  assert.deepEqual(
    third.history.filter((m) => m.role === "user").map((m) => textOfMessage(m)),
    ["甲", "乙"],
  );
  assert.equal(model.callCount, 1, "no summary/model call is generated for the paused trajectory");
});

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

test("stable environment snapshot is appended as a history system message only when changed", async () => {
  const model = new FakeModel([{ text: "一" }, { text: "二" }]);
  const session = new AgentSession(
    { systemPrompt: "sys", workingDirectory: "C:\\work", tokenBudget: 10_000 },
    { model, toolExecutor: new FakeExecutor(), estimateRequestTokens: () => 1 },
  );
  await session.runTurn({ userMessage: "甲" });
  const second = await session.runTurn({ userMessage: "乙" });
  const snapshot = buildEnvironmentSnapshot("C:\\work");
  const snapshots = second.history.filter((m) => m.role === "system" && m.text === snapshot);
  assert.equal(snapshots.length, 1, "the snapshot is appended exactly once, on change");
});

// ---------------------------------------------------------------------------
// Busy policy
// ---------------------------------------------------------------------------

test("concurrent prompt is rejected per busy policy", async () => {
  const model = new GatedModel();
  const session = new AgentSession(
    { systemPrompt: "sys", tokenBudget: 10_000 },
    { model, toolExecutor: new FakeExecutor(), estimateRequestTokens: () => 1 },
  );
  const first = session.runTurn({ userMessage: "甲" });
  try {
    await rejectsWithin(session.runTurn({ userMessage: "乙" }), isBusy, 200);
  } finally {
    model.release();
  }
  const result = await first;
  assert.equal(result.stopReason, "answer");
});

test("resetHistory during a running turn is rejected per busy policy", async () => {
  const model = new GatedModel();
  const session = new AgentSession(
    { systemPrompt: "sys", tokenBudget: 10_000 },
    { model, toolExecutor: new FakeExecutor(), estimateRequestTokens: () => 1 },
  );
  const first = session.runTurn({ userMessage: "甲" });
  try {
    assert.throws(() => session.resetHistory(), isBusy);
  } finally {
    model.release();
  }
  await first;
});

// ---------------------------------------------------------------------------
// Budget tracker
// ---------------------------------------------------------------------------

test("budget tracker sees the accumulated trajectory before tool execution and the trimmed estimate at turn end", async () => {
  const tracker = new InputBudgetTracker();
  const model = new FakeModel([
    { text: "checking", toolCalls: [{ id: "c1", name: "read", arguments: "{}" }] },
    { text: "done" },
  ]);
  let preToolEstimate = -1;
  const executor = new FakeExecutor(() => {
    preToolEstimate = tracker.currentTokens;
  });
  const session = new AgentSession(
    { systemPrompt: "sys", tokenBudget: 10_000, budgetTracker: tracker },
    { model, toolExecutor: executor, estimateRequestTokens: () => 1 },
  );
  const result = await session.runTurn({ userMessage: "甲" });
  assert.equal(result.stopReason, "answer");
  // Before tool execution the tracker saw the accumulated trajectory so far.
  assert.equal(preToolEstimate, estimateMemoryTokens(result.trajectory.slice(0, 2)));
  // At turn end the tracker holds the trimmed memory estimate (estimated, not billed).
  assert.equal(tracker.currentTokens, estimateMemoryTokens(session.history));
});

// ---------------------------------------------------------------------------
// Turn boundary behavior
// ---------------------------------------------------------------------------

test("model change takes effect at the next turn boundary", async () => {
  const modelA = new FakeModel([{ text: "from-A" }]);
  const modelB = new FakeModel([{ text: "from-B" }]);
  const session = new AgentSession(
    { systemPrompt: "sys", tokenBudget: 10_000 },
    { model: modelA, toolExecutor: new FakeExecutor(), estimateRequestTokens: () => 1 },
  );
  await session.runTurn({ userMessage: "甲" });
  session.setModel(modelB);
  await session.runTurn({ userMessage: "乙" });
  assert.equal(modelA.callCount, 1, "turn B ran on the swapped model");
  assert.equal(modelB.callCount, 1);
});

test("after setModel(B), turn B runs on B and A+B usage/cost accumulate in the session ledger", async () => {
  const usageA: TokenUsage = { inputTokens: 5, outputTokens: 7 };
  const costA: UsageCost = { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 };
  const usageB: TokenUsage = { inputTokens: 9, outputTokens: 11 };
  const costB: UsageCost = { input: 0.003, output: 0.004, cacheRead: 0, cacheWrite: 0 };
  const modelA = new FakeModel([{ text: "from-A", usage: usageA, cost: costA }]);
  const modelB = new FakeModel([{ text: "from-B", usage: usageB, cost: costB }]);
  const session = new AgentSession(
    { systemPrompt: "sys", tokenBudget: 10_000 },
    { model: modelA, toolExecutor: new FakeExecutor(), estimateRequestTokens: () => 1 },
  );
  const resultA = await session.runTurn({ userMessage: "甲" });
  assert.equal(resultA.stopReason, "answer");
  session.setModel(modelB);
  const resultB = await session.runTurn({ userMessage: "乙" });
  assert.equal(resultB.stopReason, "answer");
  assert.equal(modelA.callCount, 1);
  assert.equal(modelB.callCount, 1, "turn B ran on the swapped model");
  // Cross-turn usage/cost ledger: the host accumulates each run's usage/cost.
  assert.notEqual(session.usage, undefined, "the session must expose a cross-turn usage ledger");
  assert.deepEqual(session.usage, { inputTokens: 14, outputTokens: 18 }, "A+B usage accumulate");
  assert.notEqual(session.cost, undefined, "the session must expose the cross-turn cost ledger");
  assert.deepEqual(
    session.cost,
    { input: 0.004, output: 0.006, cacheRead: 0, cacheWrite: 0 },
    "A+B cost accumulate component-wise",
  );
});

test("a mid-turn setModel keeps the running turn on the old model stream and does not pollute the ledger", async () => {
  const modelA = new GatedModel({ inputTokens: 5, outputTokens: 7 });
  const modelB = new FakeModel([{ text: "from-B", usage: { inputTokens: 9, outputTokens: 11 } }]);
  const session = new AgentSession(
    { systemPrompt: "sys", tokenBudget: 10_000 },
    { model: modelA, toolExecutor: new FakeExecutor(), estimateRequestTokens: () => 1 },
  );
  // Turn A blocks on the gate; the test swaps the model while it is running.
  const turnA = session.runTurn({ userMessage: "甲" });
  session.setModel(modelB);
  modelA.release();
  const resultA = await turnA;
  assert.equal(resultA.answer, "done", "the running turn completed on the old model stream");
  assert.equal(modelB.callCount, 0, "the swapped model was not used by the running turn");
  assert.notEqual(session.usage, undefined, "the session must expose a cross-turn usage ledger");
  assert.deepEqual(session.usage, { inputTokens: 5, outputTokens: 7 }, "only turn A's usage is in the ledger");
  const resultB = await session.runTurn({ userMessage: "乙" });
  assert.equal(resultB.stopReason, "answer");
  assert.equal(modelB.callCount, 1, "the swap takes effect at the next turn boundary");
  assert.deepEqual(session.usage, { inputTokens: 14, outputTokens: 18 }, "turn B's usage accumulates at the next boundary");
});

test("a model resolution failure rejects at the turn boundary with an explicit error and does not disturb committed history", async () => {
  const model = new FakeModel([{ text: "answer-甲" }, { text: "never" }]);
  let failResolution = false;
  const session = new AgentSession(
    {
      systemPrompt: "sys",
      tokenBudget: 10_000,
      resolveModel: (current) => {
        if (failResolution) throw new Error("provider/model catalog unavailable");
        return current;
      },
    },
    { model, toolExecutor: new FakeExecutor(), estimateRequestTokens: () => 1 },
  );
  const resultA = await session.runTurn({ userMessage: "甲" });
  assert.equal(resultA.stopReason, "answer");
  failResolution = true;
  // Resolution failure rejects the turn with an explicit error (no silent fallback).
  await assert.rejects(
    session.runTurn({ userMessage: "乙" }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "model-resolve-failed",
  );
  assert.equal(model.callCount, 1, "no model call happened for the rejected turn");
  // Committed cross-turn history is untouched by the rejected turn.
  assert.deepEqual(
    session.history.map((message) => textOfMessage(message)),
    ["甲", "answer-甲"],
  );
  // The session is not stuck busy after the rejected turn.
  failResolution = false;
  const resultC = await session.runTurn({ userMessage: "丙" });
  assert.equal(resultC.stopReason, "answer");
});

test("no model window invents no token limit while the ledger still accumulates (regression)", async () => {
  const model = new FakeModel([
    { text: "a1", usage: { inputTokens: 2, outputTokens: 3 } },
    { text: "a2", usage: { inputTokens: 4, outputTokens: 5 } },
    { text: "a3", usage: { inputTokens: 6, outputTokens: 7 } },
  ]);
  const session = new AgentSession(
    { systemPrompt: "sys" }, // no tokenBudget, no maxHistoryTurns → no invented limit
    { model, toolExecutor: new FakeExecutor(), estimateRequestTokens: () => 1 },
  );
  await session.runTurn({ userMessage: "甲" });
  await session.runTurn({ userMessage: "乙" });
  const third = await session.runTurn({ userMessage: "丙" });
  // Regression: without a known model window, no token limit is invented.
  assert.deepEqual(
    third.history.filter((m) => m.role === "user").map((m) => textOfMessage(m)),
    ["甲", "乙"],
  );
  assert.notEqual(session.usage, undefined, "the session must expose a cross-turn usage ledger");
  assert.deepEqual(session.usage, { inputTokens: 12, outputTokens: 15 });
});

test("dynamic model budget is validated like a static session budget", async () => {
  const session = new AgentSession(
    { systemPrompt: "sys", tokenBudgetProvider: () => -1 },
    { model: new FakeModel([{ text: "unused" }]), toolExecutor: new FakeExecutor(), estimateRequestTokens: () => 1 },
  );
  await assert.rejects(session.runTurn({ userMessage: "hello" }), RangeError);
});

test("a soft-stop request is honored and cleared at turn end (no leak into the next turn)", async () => {
  const model = new FakeModel([{ text: "second" }]);
  const session = new AgentSession(
    { systemPrompt: "sys", tokenBudget: 10_000 },
    { model, toolExecutor: new FakeExecutor(), estimateRequestTokens: () => 1 },
  );
  session.requestSoftStop();
  const first = await session.runTurn({ userMessage: "甲" });
  assert.equal(first.stopReason, "interrupted");
  assert.equal(model.callCount, 0, "the soft stop is honored before the first model call");
  const second = await session.runTurn({ userMessage: "乙" });
  assert.equal(second.stopReason, "answer", "the soft-stop flag must not leak into the next turn");
  assert.equal(model.callCount, 1);
});

// ---------------------------------------------------------------------------
// Pure history helpers (direct contracts; C# TrimHistoryByTokens / SanitizeHistory)
// ---------------------------------------------------------------------------

test("sanitizeHistory removes an unpaired tool group (assistant + partial results) from the persisted tail", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "甲" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "tool-call", id: "c1", name: "read", arguments: "{}" },
        { type: "tool-call", id: "c2", name: "write", arguments: "{}" },
      ],
    },
    { role: "tool", toolCallId: "c1", content: "partial", isError: false },
    {
      role: "assistant",
      content: [
        { type: "text", text: "more" },
        { type: "tool-call", id: "c3", name: "read", arguments: "{}" },
      ],
    },
  ];
  const cleaned = sanitizeHistory(messages);
  assert.deepEqual(cleaned, messages.slice(0, 1));
});

test("sanitizeHistory keeps a fully paired tool round", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "甲" }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", id: "c1", name: "read", arguments: "{}" }],
    },
    { role: "tool", toolCallId: "c1", content: "ok", isError: false },
  ];
  assert.deepEqual(sanitizeHistory(messages), messages);
});

test("trimHistoryByTokens drops oldest whole user-turns and keeps at least the most recent one", () => {
  const long = "x".repeat(396); // 99 tokens
  const messages: AgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "甲" }] },
    { role: "assistant", content: [{ type: "text", text: long }] },
    { role: "user", content: [{ type: "text", text: "乙" }] },
    { role: "assistant", content: [{ type: "text", text: long }] },
  ];
  assert.deepEqual(trimHistoryByTokens(messages, 150), messages.slice(2));
  // A single over-budget turn is retained (keeps at least the most recent turn).
  assert.deepEqual(trimHistoryByTokens(messages.slice(0, 2), 150), messages.slice(0, 2));
});
