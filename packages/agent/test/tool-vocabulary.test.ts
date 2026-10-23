import test from "node:test";
import assert from "node:assert/strict";

import type {
  AgentRequest,
  StopReason,
  ToolExecutor,
  ToolObservation,
  ToolValidator,
} from "@di/agent";
import type { ToolCall, ToolSpec } from "@di/ai";

/**
 *
 * Asserts the @di/agent public exports match the contract in
 *
 * and architecture.md (§"契约名" table). This is the TDD red→green anchor for the
 * vocabulary: before the exports exist, typecheck fails with "has no exported member".
 */
test("StopReason is the documented closed union", () => {
  const reasons: readonly StopReason[] = [
    "answer",
    "final_output_tool",
    "max_iterations",
    "error",
    "interrupted",
    "context_limit",
  ];
  assert.deepEqual(reasons, [
    "answer",
    "final_output_tool",
    "max_iterations",
    "error",
    "interrupted",
    "context_limit",
  ]);
});

test("ToolObservation carries the executor result text plus an isError flag", () => {
  const ok: ToolObservation = { text: "ok", isError: false };
  const failed: ToolObservation = { text: "boom", isError: true };
  assert.equal(ok.text, "ok");
  assert.equal(ok.isError, false);
  assert.equal(failed.text, "boom");
  assert.equal(failed.isError, true);
});

test("ToolExecutor and ToolValidator can be implemented against a ToolCall", async () => {
  const call: ToolCall = { type: "tool-call", id: "call_1", name: "echo", arguments: "{}" };

  const executor: ToolExecutor = {
    async execute(c) {
      return { text: `result for ${c.name}`, isError: false };
    },
  };

  const validator: ToolValidator = {
    validate(c) {
      assert.equal(c.id, call.id);
      assert.equal(c.name, call.name);
    },
  };

  validator.validate(call);
  const observation = await executor.execute(call);
  assert.equal(observation.text, "result for echo");
  assert.equal(observation.isError, false);
});

test("AgentRequest carries the loop tool fields and imports @di/ai vocabulary", () => {
  const tools: readonly ToolSpec[] = [
    { name: "echo", description: "test tool", parameters: { type: "object", properties: {} } },
  ];

  const request: AgentRequest = {
    sessionId: "s1",
    systemPrompt: "test system prompt",
    userMessage: "hello",
    history: [],
    tools,
    contextTokenBudget: 1,
    maxIterations: 8,
  };

  assert.equal(request.sessionId, "s1");
  assert.equal(request.systemPrompt, "test system prompt");
  assert.equal(request.userMessage, "hello");
  assert.equal(request.history.length, 0);
  assert.equal(request.tools, tools);
  assert.equal(request.maxIterations, 8);
  assert.equal(request.contextTokenBudget, 1);
});
