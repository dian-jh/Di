/**
 * 状态机单元测试：idle→running→(cancelling)→idle 转移 + 事件 → 视图模型变更。
 * 用假事件流喂入，断言最终视图模型。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TurnStateMachine } from "../src/app/state.ts";
import type { AgentEvent, AgentResult } from "../src/rpc/protocol.ts";

const RESULT: AgentResult = {
  answer: "done",
  stop_reason: "answer",
  iterations: 1,
  usage: { input_tokens: 10, output_tokens: 5 },
  cost: 0.001,
};

describe("TurnStateMachine：状态转移", () => {
  it("idle → running → (cancelling) → idle", () => {
    const s = new TurnStateMachine();
    assert.equal(s.state, "idle");

    s.startTurn("hi");
    assert.equal(s.state, "running");
    assert.ok(s.current);
    assert.equal(s.current.userMessage, "hi");
    assert.equal(s.statusText, "运行中… (Ctrl+C 中断)");

    s.requestCancel();
    assert.equal(s.state, "cancelling");
    assert.equal(s.statusText, "正在取消… (Ctrl+C 退出)");

    s.finishTurn({ ...RESULT, stop_reason: "cancelled" });
    assert.equal(s.state, "idle");
    assert.equal(s.current, null);
    assert.ok(s.turns[0]?.finished);
  });

  it("运行中再次 startTurn 被忽略", () => {
    const s = new TurnStateMachine();
    s.startTurn("a");
    s.startTurn("b");
    assert.equal(s.turns.length, 1);
    assert.equal(s.current?.userMessage, "a");
  });

  it("idle 时 requestCancel 无效", () => {
    const s = new TurnStateMachine();
    s.requestCancel();
    assert.equal(s.state, "idle");
  });
});

describe("TurnStateMachine：事件 → 视图模型", () => {
  it("text_delta / reasoning_delta 追加到当前助手消息", () => {
    const s = new TurnStateMachine();
    s.startTurn("q");
    s.applyEvent({ kind: "text_delta", delta: "Hel" });
    s.applyEvent({ kind: "reasoning_delta", delta: "think" });
    s.applyEvent({ kind: "text_delta", delta: "lo" });
    assert.equal(s.current?.answer, "Hello");
    assert.equal(s.current?.reasoning, "think");
  });

  it("工具事件按 id 合并：参数累加、状态只前进", () => {
    const s = new TurnStateMachine();
    s.startTurn("q");
    s.applyEvent({ kind: "tool_call_delta", id: "t1", name: "fake", arguments: '{"a":' });
    s.applyEvent({ kind: "tool_call_delta", id: "t1", name: "fake", arguments: '{"a":1}' });
    s.applyEvent({ kind: "tool_started", call: { id: "t1", name: "fake", arguments: '{"a":1}' } });
    s.applyEvent({
      kind: "tool_completed",
      call: { id: "t1", name: "fake", arguments: '{"a":1}' },
      observation: "ok",
      is_error: false,
    });

    const tools = s.current?.toolCalls;
    assert.ok(tools);
    assert.equal(tools.size, 1);
    const entry = tools.get("t1")!;
    assert.equal(entry.arguments, '{"a":1}');
    assert.equal(entry.status, "completed");
    assert.equal(entry.observation, "ok");
  });

  it("工具失败：is_error → status failed", () => {
    const s = new TurnStateMachine();
    s.startTurn("q");
    s.applyEvent({ kind: "tool_started", call: { id: "t1", name: "fake", arguments: "{}" } });
    s.applyEvent({ kind: "tool_completed", call: { id: "t1", name: "fake", arguments: "{}" }, observation: "boom", is_error: true });
    assert.equal(s.current?.toolCalls.get("t1")?.status, "failed");
    assert.equal(s.current?.toolCalls.get("t1")?.observation, "boom");
  });

  it("多个工具按调用顺序保留", () => {
    const s = new TurnStateMachine();
    s.startTurn("q");
    s.applyEvent({ kind: "tool_started", call: { id: "a", name: "one", arguments: "{}" } });
    s.applyEvent({ kind: "tool_started", call: { id: "b", name: "two", arguments: "{}" } });
    assert.deepEqual([...s.current!.toolCalls.keys()], ["a", "b"]);
  });

  it("turn_completed 更新状态行脚注", () => {
    const s = new TurnStateMachine();
    s.startTurn("q");
    s.applyEvent({
      kind: "turn_completed",
      iteration: 3,
      usage: { input_tokens: 1, output_tokens: 1 },
      cost: 0.0025,
      finish_reason: "answer",
    });
    assert.equal(s.statusText, "↻ iteration 3 · $0.0025");
  });

  it("run_failed 设置错误横幅并记录 failure（回合由后续 result 终结）", () => {
    const s = new TurnStateMachine();
    s.startTurn("q");
    s.applyEvent({ kind: "run_failed", failure: { code: "E_BROKEN", message: "broken pipe" } });
    assert.equal(s.errorBanner, "broken pipe");
    assert.equal(s.current?.failure?.code, "E_BROKEN");
    assert.equal(s.state, "running"); // 终结仍由 result 负责

    s.finishTurn({ ...RESULT, stop_reason: "error", failure: { code: "E_BROKEN", message: "broken pipe" } });
    assert.equal(s.state, "idle");
  });

  it("finishTurn 累计 totalCost 并设置结果摘要", () => {
    const s = new TurnStateMachine();
    s.startTurn("q");
    s.finishTurn(RESULT);
    assert.equal(s.totalCost, 0.001);
    assert.equal(s.statusText, "✓ answer · $0.0010");
    assert.equal(s.turns[0]?.result?.answer, "done");
  });

  it("结果 stop_reason=error 且有 failure → 错误横幅", () => {
    const s = new TurnStateMachine();
    s.startTurn("q");
    s.finishTurn({ ...RESULT, stop_reason: "error", failure: { code: "E_X", message: "model blew up" } });
    assert.equal(s.errorBanner, "model blew up");
    assert.equal(s.state, "idle");
  });

  it("abort 把未终结回合标记失败并回 idle", () => {
    const s = new TurnStateMachine();
    s.startTurn("q");
    s.abort("后端进程退出（exit=1）");
    assert.equal(s.state, "idle");
    assert.equal(s.current, null);
    assert.equal(s.turns[0]?.failure?.code, "aborted");
    assert.equal(s.errorBanner, "后端进程退出（exit=1）");
  });

  it("clear 清空全部", () => {
    const s = new TurnStateMachine();
    s.startTurn("q");
    s.finishTurn(RESULT);
    s.clear();
    assert.equal(s.turns.length, 0);
    assert.equal(s.state, "idle");
    assert.equal(s.totalCost, 0);
    assert.equal(s.statusText, "idle");
  });

  it("idle 时的 stray 事件被忽略", () => {
    const s = new TurnStateMachine();
    s.applyEvent({ kind: "text_delta", delta: "stray" });
    s.applyEvent({ kind: "tool_started", call: { id: "x", name: "y", arguments: "{}" } });
    assert.equal(s.current, null);
    assert.equal(s.state, "idle");
  });
});

describe("TurnStateMachine：整段假事件流", () => {
  it("一回合：事件流 → 最终视图模型", () => {
    const s = new TurnStateMachine();
    const events: AgentEvent[] = [
      { kind: "text_delta", delta: "Hello" },
      { kind: "reasoning_delta", delta: "第一步" },
      { kind: "tool_call_delta", id: "t1", name: "ls", arguments: '{"dir":' },
      { kind: "tool_call_delta", id: "t1", name: "ls", arguments: '{"dir":"."}' },
      { kind: "tool_started", call: { id: "t1", name: "ls", arguments: '{"dir":"."}' } },
      { kind: "tool_completed", call: { id: "t1", name: "ls", arguments: '{"dir":"."}' }, observation: "file.txt", is_error: false },
      { kind: "text_delta", delta: " world" },
      { kind: "turn_completed", iteration: 1, usage: { input_tokens: 5, output_tokens: 3 }, cost: 0.0004, finish_reason: "answer" },
    ];
    s.startTurn("列出当前目录");
    for (const e of events) s.applyEvent(e);
    s.finishTurn(RESULT);

    assert.equal(s.state, "idle");
    const turn = s.turns[0]!;
    assert.equal(turn.answer, "Hello world");
    assert.equal(turn.reasoning, "第一步");
    assert.equal(turn.toolCalls.size, 1);
    const tool = turn.toolCalls.get("t1")!;
    assert.equal(tool.status, "completed");
    assert.equal(tool.observation, "file.txt");
    assert.equal(turn.result?.stop_reason, "answer");
    assert.equal(s.totalCost, 0.001);
  });
});
