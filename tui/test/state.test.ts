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

  it("finishTurn 累计 totalCost 并设置回合统计摘要", () => {
    const s = new TurnStateMachine();
    s.startTurn("q");
    s.finishTurn(RESULT);
    assert.equal(s.totalCost, 0.001);
    // 左下角摘要对齐 REPL（TokenUsage.ToString 同款：可空键缺省视作 0，total 兜底计费输入+输出；cost F6）。
    assert.equal(s.statusText, "1 轮 · tokens: in=10 (cache_read=0) out=5 (reasoning=0) total=15 · cost:$0.001000");
    assert.equal(s.turns[0]?.result?.answer, "done");
  });

  it("finishTurn 记录完整 token/成本摘要（含缓存命中与推理 token）", () => {
    const s = new TurnStateMachine();
    s.startTurn("q");
    s.finishTurn({
      answer: "done",
      stop_reason: "answer",
      iterations: 1,
      usage: {
        input_tokens: 2316,
        output_tokens: 116,
        cache_read_tokens: 2176,
        reasoning_tokens: 29,
        total_tokens: 2432,
      },
      cost: 0.00085,
    });
    assert.equal(s.statusText, "1 轮 · tokens: in=2316 (cache_read=2176) out=116 (reasoning=29) total=2432 · cost:$0.000850");
  });

  it("finishTurn 取消回合显示已取消而非 0 轮统计", () => {
    const s = new TurnStateMachine();
    s.startTurn("q");
    s.finishTurn({ ...RESULT, stop_reason: "cancelled" });
    assert.equal(s.statusText, "已取消");
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
    assert.equal(s.statusText, "", "clear 后状态行清空（dock 中塌缩不显示）");
  });

  it("idle 时的 stray 事件被忽略", () => {
    const s = new TurnStateMachine();
    s.applyEvent({ kind: "text_delta", delta: "stray" });
    s.applyEvent({ kind: "tool_started", call: { id: "x", name: "y", arguments: "{}" } });
    assert.equal(s.current, null);
    assert.equal(s.state, "idle");
  });
});

describe("TurnStateMachine：斜杠命令展示", () => {
  it("startCommand / finishCommand 记录命令输入输出，不改变回合状态", () => {
    const s = new TurnStateMachine();

    s.startCommand("/model deepseek-chat");
    assert.equal(s.state, "idle");   // 命令不进入回合状态机
    assert.equal(s.commandInput, "/model deepseek-chat");
    assert.equal(s.commandOutput, "");

    s.finishCommand("模型已切换为 deepseek-chat");
    assert.equal(s.commandOutput, "模型已切换为 deepseek-chat");
    assert.equal(s.commandSeq, 1);
  });

  it("运行中 startCommand 被忽略", () => {
    const s = new TurnStateMachine();
    s.startTurn("q");

    s.startCommand("/model x");

    assert.equal(s.commandInput, "");
    assert.equal(s.commandSeq, 0);
  });
});

describe("TurnStateMachine：元数据（模型/强度/补全数据）", () => {
  it("setMeta 写入模型/强度/skills/models，modelLabel 拼接", () => {
    const s = new TurnStateMachine();
    s.setMeta({
      type: "ready",
      version: "0.1.0",
      model: "deepseek-flash",
      effort: "high",
      skills: [{ name: "backend-tests", description: "跑后端测试" }],
      models: [{ id: "deepseek-v4-pro", name: "DeepSeek Pro" }],
    });
    assert.equal(s.model, "deepseek-flash");
    assert.equal(s.effort, "high");
    assert.equal(s.skills.length, 1);
    assert.equal(s.skills[0]?.name, "backend-tests");
    assert.equal(s.models.length, 1);
    assert.equal(s.modelLabel(), "deepseek-flash · high");
  });

  it("applyModel 更新模型/强度（/model 命令后）", () => {
    const s = new TurnStateMachine();
    s.setMeta({ type: "ready", version: "0.1.0", model: "deepseek-flash", effort: "high" });
    s.applyModel("deepseek-v4-pro", "low");
    assert.equal(s.model, "deepseek-v4-pro");
    assert.equal(s.effort, "low");
    assert.equal(s.modelLabel(), "deepseek-v4-pro · low");
  });

  it("无强度时 modelLabel 只显示模型名", () => {
    const s = new TurnStateMachine();
    s.setMeta({ type: "ready", version: "0.1.0", model: "deepseek-flash", effort: null });
    assert.equal(s.modelLabel(), "deepseek-flash");
  });

  it("缺省元数据时 modelLabel 为空", () => {
    const s = new TurnStateMachine();
    assert.equal(s.modelLabel(), "");
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
