import test from "node:test";
import assert from "node:assert/strict";

import type { ChatModel, ModelEvent, ModelRequest, ModelResponse, ToolCall } from "@di/ai";
import type { ToolExecutor, ToolObservation } from "@di/agent";
import type { Skill } from "@di/coding-agent";
import { AgentSession, LexicalSkillMatcher, computeSkillActivation } from "@di/coding-agent";

/**
 * P6.2b disclosure gate — body injection reuses `AgentSession`'s volatile
 * request tail (turn-boundary read): the activation body reaches the model as a
 * volatile tail system message and NEVER enters persistent cross-turn history.
 * The activation-set computation is a pure function of (message, available
 * skills), so every mode (REPL / print / JSON / RPC) that feeds the same message
 * through the same `AgentSession` computes the identical activation set.
 */

const backendTests: Skill = {
  name: "backend-tests",
  description: "运行并修复后端测试。当用户要求运行测试、分析失败或修复测试时使用。",
  instructions: "1. dotnet build\n2. dotnet test",
  metadata: {},
  allowedTools: [],
  disableModelInvocation: false,
  directory: "",
};

class RecordingModel implements ChatModel {
  readonly requests: ModelRequest[] = [];
  stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const response: ModelResponse = {
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      finishReason: { type: "stop" },
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "fake",
      timestamp: 1_700_000_000_000,
    };
    return (async function* (): AsyncGenerator<ModelEvent> {
      yield { type: "completed", response };
    })();
  }
}

class NoopExecutor implements ToolExecutor {
  execute(_call: ToolCall): Promise<ToolObservation> {
    return Promise.resolve({ text: "ok", isError: false });
  }
}

test("computed activation body enters the volatile system context, never history", async () => {
  const model = new RecordingModel();
  const session = new AgentSession(
    { systemPrompt: "" },
    { model, toolExecutor: new NoopExecutor(), estimateRequestTokens: () => 1 },
  );

  // The pure computation seam every mode shares.
  const { active } = computeSkillActivation("跑一下后端测试", [backendTests], [], new LexicalSkillMatcher());
  assert.deepEqual(active.map((s) => s.name), ["backend-tests"]);

  // Host wiring is one line: full Skill → the session's ActiveSkill shape.
  session.setActiveSkills(active.map((s) => ({ name: s.name, instructions: s.instructions })));

  const result = await session.runTurn({ userMessage: "跑一下后端测试" });

  assert.equal(result.stopReason, "answer");
  const request = model.requests[0]!;
  const tail = request.messages[request.messages.length - 1]!;
  if (tail.role === "system") {
    assert.match(tail.text, /【已激活 Skill：backend-tests】/);
    assert.match(tail.text, /1\. dotnet build/);
  } else {
    assert.fail("expected the volatile skill body as the tail system message");
  }

  // Persistent history holds only the trajectory (user + assistant): the volatile
  // skill body is never persisted across turns.
  assert.ok(
    !session.history.some((m) => m.role === "system" && m.text.includes("dotnet build")),
    "skill instructions must not pollute persistent history",
  );
});
