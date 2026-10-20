import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentMessage, ChatModel, ContentBlock, ModelEvent, ModelRequest, ModelResponse, TokenUsage, ToolCall } from "@di/ai";
import { textOfMessage } from "@di/ai";
import type { ToolExecutor, ToolObservation } from "@di/agent";
import { AgentSession, loadRecovery, SessionStore } from "@di/coding-agent";

/**
 * P5 in-process recovery integration with AgentSession (C# baseline
 * `Core/AgentLoop/AgentRunner.cs` `RunAsync` catch / `RestoreHistory` /
 * `ResetHistory` / `_recoveryBlockedReason`).
 *
 * - after a model error the same host reloads the durable checkpoint into memory
 *   and the next turn continues WITHOUT re-executing tools (completed results are
 *   reused);
 * - a started-but-unfinished tool outcome BLOCKS in-process retry until
 *   `resetHistory` (never replayed, never fabricated);
 * - a restored (resumed) task with a tool result survives a `context_limit`
 *   pause and continues when the budget is extended;
 * - `/clear` (resetHistory) writes an empty next snapshot so recovery never
 *   revives cleared turns;
 * - a checkpoint intent write failure prevents tool execution entirely;
 * - no session store => no session log is ever produced (`--no-session`).
 */

type ModelStep =
  | { kind: "response"; text: string; toolCalls?: readonly { id: string; name: string; arguments: string }[]; usage?: TokenUsage }
  | { kind: "throw"; error: Error };

/** Scripted ChatModel: one `completed` per call; throws a step synchronously; repeats the last step. */
class ScriptedModel implements ChatModel {
  readonly requests: ModelRequest[] = [];
  private readonly steps_: readonly ModelStep[];
  private index_ = 0;

  constructor(steps: readonly ModelStep[]) {
    if (steps.length === 0) throw new Error("ScriptedModel: at least one step required");
    this.steps_ = steps;
  }

  stream(request: ModelRequest, _signal?: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const step = this.steps_[Math.min(this.index_, this.steps_.length - 1)]!;
    this.index_ += 1;
    if (step.kind === "throw") throw step.error;
    const response: ModelResponse = {
      message: { role: "assistant", content: assistantContent(step) },
      finishReason: (step.toolCalls?.length ?? 0) > 0 ? { type: "tool-calls" } : { type: "stop" },
      usage: step.usage ?? { inputTokens: 0, outputTokens: 0 },
      model: "fake",
      timestamp: 1_700_000_000_000,
    };
    return (async function* (): AsyncGenerator<ModelEvent> {
      yield { type: "completed", response };
    })();
  }
}

function assistantContent(step: Extract<ModelStep, { kind: "response" }>): readonly ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: "text", text: step.text }];
  for (const call of step.toolCalls ?? []) {
    blocks.push({ type: "tool-call", id: call.id, name: call.name, arguments: call.arguments });
  }
  return blocks;
}

/** Records calls; returns a canned result, or throws for the first call when `failWith` is set. */
class ScriptedExecutor implements ToolExecutor {
  readonly calls: ToolCall[] = [];
  private readonly failWith_?: () => Error;

  constructor(failWith?: () => Error) {
    this.failWith_ = failWith;
  }

  async execute(call: ToolCall, _signal?: AbortSignal): Promise<ToolObservation> {
    if (this.calls.length === 0 && this.failWith_ !== undefined) throw this.failWith_();
    this.calls.push(call);
    return { text: "tool output", isError: false };
  }
}

/** Character-count estimate; deterministic for the budget-pause scenario. */
function estimateRequestTokens(request: ModelRequest): number {
  return request.messages.reduce((n, m) => n + textOfMessage(m).length, 0);
}

function newSession(
  model: ChatModel,
  executor: ToolExecutor,
  options: { sessionStore?: SessionStore; tokenBudget?: number } = {},
): AgentSession {
  const config: {
    systemPrompt: string;
    sessionStore?: SessionStore;
    tokenBudget?: number;
  } = { systemPrompt: "" };
  if (options.sessionStore !== undefined) config.sessionStore = options.sessionStore;
  if (options.tokenBudget !== undefined) config.tokenBudget = options.tokenBudget;
  return new AgentSession(config, {
    model,
    toolExecutor: executor,
    estimateRequestTokens,
  });
}

test("same-process continues after a model error without re-executing tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "di-agent-recovery-"));
  try {
    const store = new SessionStore({ rootDirectory: root });
    const model = new ScriptedModel([
      { kind: "response", text: "checking", toolCalls: [{ id: "c1", name: "read", arguments: "{}" }] },
      { kind: "throw", error: new Error("model stopped") },
      { kind: "response", text: "done" },
    ]);
    const executor = new ScriptedExecutor();
    const session = newSession(model, executor, { sessionStore: store });

    await assert.rejects(session.runTurn({ userMessage: "inspect" }), /model stopped/);
    // The completed tool result was durable before the model call failed.
    assert.equal(executor.calls.length, 1);

    const result = await session.runTurn({ userMessage: "continue" });
    assert.equal(result.stopReason, "answer");
    assert.equal(executor.calls.length, 1, "the completed tool must NOT be re-executed");
    assert.ok(
      model.requests[2]!.messages.some((m) => m.role === "tool" && m.toolCallId === "c1" && m.content === "tool output"),
      "the next model request must carry the recovered tool result",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown tool outcome blocks in-process retry until history reset", async () => {
  const root = mkdtempSync(join(tmpdir(), "di-agent-recovery-"));
  try {
    const store = new SessionStore({ rootDirectory: root });
    const model = new ScriptedModel([
      { kind: "response", text: "writing", toolCalls: [{ id: "c1", name: "write", arguments: "{}" }] },
      { kind: "response", text: "done" },
    ]);
    const executor = new ScriptedExecutor(() => new DOMException("The operation was aborted.", "AbortError"));
    const session = newSession(model, executor, { sessionStore: store });

    await assert.rejects(session.runTurn({ userMessage: "write file" }), (error: unknown) => {
      assert.equal((error as Error).name, "AbortError");
      return true;
    });
    assert.equal(executor.calls.length, 0, "the throwing executor never counted a run");

    // A started tool with no durable outcome: the same host must refuse to continue.
    await assert.rejects(session.runTurn({ userMessage: "continue" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("unknown"), error.message);
      return true;
    });

    session.resetHistory();
    const result = await session.runTurn({ userMessage: "continue again" });
    assert.equal(result.stopReason, "answer");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restored task and tool result survive a context_limit pause and continue with an extended budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "di-agent-recovery-"));
  try {
    const model = new ScriptedModel([{ kind: "response", text: "done" }]);
    const executor = new ScriptedExecutor();
    const config: { systemPrompt: string; tokenBudget: number } = { systemPrompt: "", tokenBudget: 1 };
    const session = new AgentSession(config, { model, toolExecutor: executor, estimateRequestTokens });
    session.restoreHistory([
      { role: "user", content: [{ type: "text", text: "original task" }] },
      { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", content: "important tool output", isError: false },
    ]);

    const paused = await session.runTurn({ userMessage: "continue" });
    assert.equal(paused.stopReason, "context_limit");
    assert.equal(model.requests.length, 0, "a paused turn must not call the model");
    assert.ok(paused.trajectory.some((m) => textOfMessage(m) === "original task"));
    assert.ok(paused.trajectory.some((m) => m.role === "tool" && m.content === "important tool output"));

    config.tokenBudget = 100_000; // extend the budget: the paused task may now proceed
    await session.runTurn({ userMessage: "continue with room" });
    assert.equal(model.requests.length, 1);
    assert.ok(model.requests[0]!.messages.some((m) => textOfMessage(m) === "original task"));
    assert.ok(model.requests[0]!.messages.some((m) => m.role === "tool" && m.content === "important tool output"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clear (resetHistory) writes an empty snapshot so recovery never revives cleared turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "di-agent-recovery-"));
  try {
    const store = new SessionStore({ rootDirectory: root });
    const model = new ScriptedModel([
      { kind: "response", text: "old answer" },
      { kind: "response", text: "new answer" },
    ]);
    const session = newSession(model, new ScriptedExecutor(), { sessionStore: store });

    await session.runTurn({ userMessage: "old task" });
    session.resetHistory();
    await session.runTurn({ userMessage: "new task" });

    const recovered = loadRecovery(store.logFilePath);
    assert.ok(recovered.some((m) => m.role === "user" && textOfMessage(m) === "new task"));
    assert.ok(!recovered.some((m) => textOfMessage(m) === "old task"));
    assert.ok(!recovered.some((m) => textOfMessage(m) === "old answer"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an intent checkpoint write failure prevents tool execution entirely", async () => {
  const root = mkdtempSync(join(tmpdir(), "di-agent-recovery-"));
  try {
    class FailingStartStore extends SessionStore {
      override checkpointToolStarted(_call: ToolCall): void {
        throw new Error("disk full");
      }
    }
    const store = new FailingStartStore({ rootDirectory: root });
    const model = new ScriptedModel([
      { kind: "response", text: "work", toolCalls: [{ id: "c1", name: "danger", arguments: "{}" }] },
    ]);
    const executor = new ScriptedExecutor();
    const session = newSession(model, executor, { sessionStore: store });

    await assert.rejects(session.runTurn({ userMessage: "do it" }), /disk full/);
    assert.equal(executor.calls.length, 0, "the tool must NEVER run when its intent cannot be persisted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no session store produces no session log (--no-session)", async () => {
  const root = mkdtempSync(join(tmpdir(), "di-agent-recovery-"));
  try {
    const model = new ScriptedModel([{ kind: "response", text: "ok" }]);
    const session = newSession(model, new ScriptedExecutor());
    const result = await session.runTurn({ userMessage: "hello" });
    assert.equal(result.stopReason, "answer");
    assert.equal(readdirSync(root).length, 0, "no session store => no file anywhere");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
