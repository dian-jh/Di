import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentMessage, ToolResultMessage } from "@di/ai";
import { textOfMessage } from "@di/ai";
import { loadRecovery, SessionDataError, SessionStore } from "@di/coding-agent";

/**
 *
 * Every corruption/unknown case is red by ASSERTION: recovery must fail closed
 * with the exact state-machine outcome, carry a physical line number where one
 * exists, never skip a bad line as if blank, never replay a started-but-unfinished
 * tool, and only a torn FINAL line (no LF) is silently dropped.
 */

const NOT_EXECUTED =
  "Recovery note: this tool call was not executed before the checkpoint. Decide whether it is still needed.";

function toolCall(id: string, name: string, args: string): AgentMessage {
  return { role: "assistant", content: [{ type: "tool-call", id, name, arguments: args }] };
}

function toolResult(id: string, text: string, isError = false): ToolResultMessage {
  return { role: "tool", toolCallId: id, content: text, isError };
}

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "di-session-recovery-"));
}

test("started-without-result is rejected with the call id (fail closed)", () => {
  const root = newRoot();
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("continue", 1_700_000_000_000);
    store.appendCheckpointMessage(toolCall("call-9", "write", "{}"));
    store.checkpointToolStarted({ type: "tool-call", id: "call-9", name: "write", arguments: "{}" });

    assert.throws(
      () => loadRecovery(store.logFilePath),
      (error: unknown) => {
        assert.ok(error instanceof SessionDataError);
        assert.equal(error.code, "unknown-outcome");
        assert.ok(error.message.includes("call-9"));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assistant-only prefix recovers with an explicit not-executed observation", () => {
  const root = newRoot();
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("inspect", 1_700_000_000_000);
    store.appendCheckpointMessage(toolCall("call-10", "read", "{}"));

    const trajectory = loadRecovery(store.logFilePath);
    const results = trajectory.filter((m) => m.role === "tool");
    assert.equal(results.length, 1);
    const result = results[0]!;
    assert.equal(result.role, "tool");
    assert.equal(result.toolCallId, "call-10");
    assert.ok(result.content.includes("not executed"));
    assert.equal(result.isError, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each checkpoint prefix boundary is safe", () => {
  const root = newRoot();
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("do it", 1_700_000_000_000);
    store.appendCheckpointMessage(toolCall("prefix-call", "write", "{}"));
    const assistantPrefix = readFileSync(store.logFilePath, "utf8");
    store.checkpointToolStarted({ type: "tool-call", id: "prefix-call", name: "write", arguments: "{}" });
    const startedPrefix = readFileSync(store.logFilePath, "utf8");
    store.checkpointToolCompleted(toolResult("prefix-call", "written"));
    const completedPrefix = readFileSync(store.logFilePath, "utf8");

    const assistantOnly = join(root, "assistant-only.jsonl");
    writeFileSync(assistantOnly, assistantPrefix);
    const repaired = loadRecovery(assistantOnly);
    const note = repaired.find((m): m is ToolResultMessage => m.role === "tool" && m.toolCallId === "prefix-call");
    assert.ok(note && note.content.includes("not executed"));

    const startedOnly = join(root, "started-only.jsonl");
    writeFileSync(startedOnly, startedPrefix);
    assert.throws(
      () => loadRecovery(startedOnly),
      (error: unknown) => {
        assert.ok(error instanceof SessionDataError);
        assert.equal(error.code, "unknown-outcome");
        assert.ok(error.message.includes("prefix-call"));
        return true;
      },
    );

    const completed = join(root, "completed.jsonl");
    writeFileSync(completed, completedPrefix);
    const recovered = loadRecovery(completed);
    assert.ok(
      recovered.some((m) => m.role === "tool" && m.toolCallId === "prefix-call" && m.content === "written"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial assistant batch completes: one result preserved, the other gets the note", () => {
  const root = newRoot();
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("run deployment", 1_700_000_000_000);
    store.appendCheckpointMessage({
      role: "assistant",
      content: [
        { type: "text", text: "部署并验证" },
        { type: "tool-call", id: "c1", name: "deploy", arguments: "{}" },
        { type: "tool-call", id: "c2", name: "verify", arguments: "{}" },
      ],
    });
    store.checkpointToolStarted({ type: "tool-call", id: "c1", name: "deploy", arguments: "{}" });
    store.checkpointToolCompleted(toolResult("c1", "deployed ok"));
    // c2 never started; crash here.

    const trajectory = loadRecovery(store.logFilePath);
    const results = trajectory.filter((m) => m.role === "tool");
    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((m) => ({ id: m.toolCallId, content: m.content })),
      [
        { id: "c1", content: "deployed ok" },
        { id: "c2", content: NOT_EXECUTED },
      ],
    );
    assert.equal(results[1]!.isError, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same call id across separate assistant batches is legal, never globally deduped", () => {
  const root = newRoot();
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("repeat", 1_700_000_000_000);
    store.appendCheckpointMessage(toolCall("same", "read", "{}"));
    store.checkpointToolStarted({ type: "tool-call", id: "same", name: "read", arguments: "{}" });
    store.checkpointToolCompleted(toolResult("same", "first result"));
    store.appendCheckpointMessage(toolCall("same", "read", "{}"));

    const trajectory = loadRecovery(store.logFilePath);
    const results = trajectory.filter((m) => m.role === "tool");
    assert.equal(results.length, 2);
    assert.equal(results[0]!.content, "first result");
    assert.ok(results[1]!.content.includes("not executed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate tool call id within one assistant batch is rejected", () => {
  const root = newRoot();
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("repeat", 1_700_000_000_000);
    store.appendCheckpointMessage({
      role: "assistant",
      content: [
        { type: "tool-call", id: "dup", name: "read", arguments: "{}" },
        { type: "tool-call", id: "dup", name: "read", arguments: "{}" },
      ],
    });

    assert.throws(
      () => loadRecovery(store.logFilePath),
      (error: unknown) => {
        assert.ok(error instanceof SessionDataError);
        assert.equal(error.code, "corrupt");
        assert.ok(/[Dd]uplicate tool call id/.test(error.message));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy audit-only log is explicitly rejected, never guessed from audit messages", () => {
  const root = newRoot();
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.startSession();
    store.appendTurn(
      {
        answer: "done",
        trajectory: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        history: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        iterations: 1,
        stopReason: "answer",
      },
      1_700_000_000_000,
    );

    assert.throws(
      () => loadRecovery(store.logFilePath),
      (error: unknown) => {
        assert.ok(error instanceof SessionDataError);
        assert.equal(error.code, "no-checkpoint");
        assert.ok(/no recovery checkpoints/.test(error.message));
        assert.ok(/older versions/.test(error.message));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a torn final line (no LF) is ignored; a corrupt interior line is rejected", () => {
  const root = newRoot();
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("safe", 1_700_000_000_000);
    store.appendCheckpointMessage({ role: "assistant", content: [{ type: "text", text: "answer" }] });
    const valid = readFileSync(store.logFilePath, "utf8");

    const tornTail = join(root, "torn-tail.jsonl");
    writeFileSync(tornTail, valid + '{"type":"checkpoint_turn_started"');
    const recovered = loadRecovery(tornTail);
    assert.ok(recovered.some((m) => m.role === "assistant" && textOfMessage(m) === "answer"));

    const corruptInterior = join(root, "corrupt-interior.jsonl");
    writeFileSync(corruptInterior, valid + "{invalid}\n" + valid);
    assert.throws(
      () => loadRecovery(corruptInterior),
      (error: unknown) => {
        assert.ok(error instanceof SessionDataError);
        assert.equal(error.code, "corrupt");
        assert.ok(/line \d+/.test(error.message));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty interior lines are ignored, not treated as corruption", () => {
  const root = newRoot();
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("spaced", 1_700_000_000_000);
    store.appendCheckpointMessage({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    const valid = readFileSync(store.logFilePath, "utf8");
    const withBlanks = join(root, "blanks.jsonl");
    writeFileSync(withBlanks, valid.replace(/\n/g, "\n\n") + "\n\n");
    const recovered = loadRecovery(withBlanks);
    assert.equal(recovered.filter((m) => m.role === "assistant").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown top-level record type is rejected with type and line number", () => {
  const root = newRoot();
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("x", 1_700_000_000_000);
    const valid = readFileSync(store.logFilePath, "utf8");
    const file = join(root, "unknown-top.jsonl");
    writeFileSync(
      file,
      valid + '{"timestamp":"2026-10-19T03:04:05.000Z","ordinal":1,"type":"future_state_marker","payload":{}}\n',
    );
    assert.throws(
      () => loadRecovery(file),
      (error: unknown) => {
        assert.ok(error instanceof SessionDataError);
        assert.equal(error.code, "unknown-record");
        assert.ok(error.message.includes("future_state_marker"));
        assert.ok(/line 3/.test(error.message));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown checkpoint record type is rejected, never skipped as an audit line", () => {
  const root = newRoot();
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("x", 1_700_000_000_000);
    const valid = readFileSync(store.logFilePath, "utf8");
    const file = join(root, "unknown-checkpoint.jsonl");
    writeFileSync(
      file,
      valid + '{"timestamp":"2026-10-19T03:04:05.000Z","ordinal":1,"type":"checkpoint_tool_aborted","payload":{"call_id":"c1"}}\n',
    );
    assert.throws(
      () => loadRecovery(file),
      (error: unknown) => {
        assert.ok(error instanceof SessionDataError);
        assert.equal(error.code, "unknown-record");
        assert.ok(error.message.includes("checkpoint_tool_aborted"));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphan tool start and orphan tool completion are rejected", () => {
  const root = newRoot();
  try {
    // orphan start: not preceded by any assistant batch with that call id.
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("inspect", 1_700_000_000_000);
    store.checkpointToolStarted({ type: "tool-call", id: "orphan", name: "write", arguments: "{}" });
    assert.throws(
      () => loadRecovery(store.logFilePath),
      (error: unknown) => {
        assert.ok(error instanceof SessionDataError);
        assert.equal(error.code, "corrupt");
        assert.ok(/[Oo]rphan or duplicate tool-start/.test(error.message));
        return true;
      },
    );

    // orphan completion: completed without a matching started record.
    const root2 = newRoot();
    try {
      const store2 = new SessionStore({ rootDirectory: root2 });
      store2.beginCheckpointTurn("inspect", 1_700_000_000_000);
      store2.appendCheckpointMessage(toolCall("c1", "read", "{}"));
      store2.checkpointToolCompleted(toolResult("c1", "r"));
      assert.throws(
        () => loadRecovery(store2.logFilePath),
        (error: unknown) => {
          assert.ok(error instanceof SessionDataError);
          assert.equal(error.code, "corrupt");
          assert.ok(/has no matching started record/.test(error.message));
          return true;
        },
      );
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new turn start with a still-pending started record is rejected", () => {
  const root = newRoot();
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("first", 1_700_000_000_000);
    store.appendCheckpointMessage(toolCall("c1", "read", "{}"));
    store.checkpointToolStarted({ type: "tool-call", id: "c1", name: "read", arguments: "{}" });
    store.beginCheckpointTurn("second", 1_700_000_000_001);

    assert.throws(
      () => loadRecovery(store.logFilePath),
      (error: unknown) => {
        assert.ok(error instanceof SessionDataError);
        assert.equal(error.code, "unknown-outcome");
        assert.ok(error.message.includes("c1"));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete tool round recovers the exact user -> assistant -> tool -> assistant trajectory", () => {
  const root = newRoot();
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("检查并修复构建", 1_700_000_000_000);
    store.appendCheckpointMessage({
      role: "assistant",
      content: [
        { type: "reasoning", text: "先检查构建输出" },
        { type: "tool-call", id: "call-01", name: "read_file", arguments: '{"path":"build.log"}' },
      ],
    });
    store.checkpointToolStarted({ type: "tool-call", id: "call-01", name: "read_file", arguments: '{"path":"build.log"}' });
    store.checkpointToolCompleted(toolResult("call-01", "error CS1002"));
    store.appendCheckpointMessage({ role: "assistant", content: [{ type: "text", text: "缺少分号" }] });
    store.completeCheckpointTurn({ stopReason: "answer", iterations: 2 });

    const trajectory = loadRecovery(store.logFilePath);
    assert.deepEqual(
      trajectory.map((m) => m.role),
      ["user", "assistant", "tool", "assistant"],
    );
    const toolResultMsg = trajectory[2]!;
    assert.equal(toolResultMsg.role, "tool");
    assert.equal(toolResultMsg.toolCallId, "call-01");
    assert.equal(toolResultMsg.content, "error CS1002");
    assert.equal(toolResultMsg.isError, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
