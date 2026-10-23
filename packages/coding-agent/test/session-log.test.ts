import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import type { AgentResult } from "@di/agent";
import { SessionStore } from "@di/coding-agent";

/**
 *
 * `AppendCheckpointMessage` / `CheckpointToolStarted` / `CheckpointToolCompleted` /
 * `CompleteCheckpointTurn` / `AppendTurn` / `AppendFailure`).
 *
 * The session_meta line is first with ordinal 0; ordinals are monotonic across
 * turns; Chinese content is written as raw UTF-8 (no replacement char); the
 * checkpoint tool-started record is durable BEFORE any tool can run; the tool
 * result and its completion marker share one atomic JSONL line; the audit turn
 *
 */

interface JsonRecord {
  timestamp: string;
  ordinal: number;
  type: string;
  payload: Record<string, unknown>;
}

function readRecords(path: string): JsonRecord[] {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRecord);
}

function newStore(root: string): SessionStore {
  return new SessionStore({ rootDirectory: root });
}

test("startSession creates a jsonl with session_meta first and default fields", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-log-"));
  try {
    const store = newStore(root);
    store.startSession();

    const records = readRecords(store.logFilePath);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.type, "session_meta");
    assert.equal(records[0]!.ordinal, 0);

    const payload = records[0]!.payload;
    assert.equal(payload.session_id, store.sessionId);
    assert.equal(payload.id, store.sessionId);
    assert.equal(payload.originator, "di");
    assert.equal(payload.cli_version, "0.1.0");
    assert.equal(payload.source, "cli");
    assert.equal(payload.thread_source, "user");
    assert.equal(payload.model_provider, "deepseek");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startSession is idempotent and recordCount tracks ordinals", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-log-"));
  try {
    const store = newStore(root);
    store.startSession();
    store.startSession();
    assert.equal(readRecords(store.logFilePath).length, 1);
    assert.equal(store.recordCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session file lives under a UTC date directory with a stable name prefix", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-log-"));
  try {
    const store = newStore(root);
    store.startSession();
    const now = new Date();
    const expectedDir = join(
      root,
      "sessions",
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
    );
    assert.ok(store.logFilePath.startsWith(expectedDir + sep));
    const name = store.logFilePath.split(/[\\/]/).pop()!;
    assert.ok(name.startsWith("session-"));
    assert.ok(name.endsWith(".jsonl"));
    assert.match(name, /^session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{8}\.jsonl$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("constructor does not create or overwrite a user config.json", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-log-"));
  try {
    assert.ok(!readdirSync(root).includes("config.json"));
    writeFileSync(join(root, "config.json"), '{"custom":true}');
    new SessionStore({ rootDirectory: root });
    assert.equal(readFileSync(join(root, "config.json"), "utf8"), '{"custom":true}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinals are monotonic and unique across checkpoint records", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-log-"));
  try {
    const store = newStore(root);
    store.beginCheckpointTurn("你好", 1_700_000_000_000);
    store.appendCheckpointMessage({ role: "assistant", content: [{ type: "text", text: "我先查一下" }] });
    store.completeCheckpointTurn({ stopReason: "answer", iterations: 1 });
    store.beginCheckpointTurn("第二问", 1_700_000_000_001);

    const ordinals = readRecords(store.logFilePath).map((r) => r.ordinal);
    assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b));
    assert.equal(new Set(ordinals).size, ordinals.length);
    assert.equal(ordinals[0], 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("chinese content is written as utf8 with no replacement character", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-log-"));
  try {
    const store = newStore(root);
    store.beginCheckpointTurn("系统找不到指定的路径", 1_700_000_000_000);
    const text = readFileSync(store.logFilePath, "utf8");
    assert.ok(text.includes("系统找不到指定的路径"));
    assert.ok(!text.includes("�"));
    assert.ok(!text.includes("\\u"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("beginCheckpointTurn snapshots history and the current user message", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-log-"));
  try {
    const store = newStore(root);
    const history = [
      { role: "system" as const, text: "环境快照" },
      { role: "user" as const, content: [{ type: "text" as const, text: "旧问题" }] },
    ];
    store.beginCheckpointTurn("新问题", 1_700_000_000_000, history);

    const record = readRecords(store.logFilePath).find((r) => r.type === "checkpoint_turn_started");
    assert.ok(record);
    const payload = record.payload as {
      started_at: number;
      history: unknown[];
      user: { role: string; blocks: unknown[] };
    };
    assert.equal(payload.started_at, 1_700_000_000_000);
    // The snapshot is serialized to the wire shape (snake_case `blocks`, not the
    // in-memory `content`).
    assert.deepEqual(payload.history, [
      { role: "system", text: "环境快照" },
      { role: "user", blocks: [{ type: "text", text: "旧问题" }] },
    ]);
    assert.deepEqual(payload.user, { role: "user", blocks: [{ type: "text", text: "新问题" }] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint tool start is durable before a tool can run", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-log-"));
  try {
    const store = newStore(root);
    store.beginCheckpointTurn("run deployment", 1_700_000_000_000);
    store.checkpointToolStarted({ type: "tool-call", id: "call-7", name: "deploy", arguments: "{}" });

    const record = readRecords(store.logFilePath).find((r) => r.type === "checkpoint_tool_started");
    assert.ok(record);
    const payload = record.payload as { call_id: string; name: string; arguments: string };
    assert.equal(payload.call_id, "call-7");
    assert.equal(payload.name, "deploy");
    assert.equal(payload.arguments, "{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete result and completion marker share one atomic line each", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-log-"));
  try {
    const store = newStore(root);
    store.beginCheckpointTurn("run deployment", 1_700_000_000_000);
    store.checkpointToolCompleted({ role: "tool", toolCallId: "call-7", content: "written", isError: false });
    store.completeCheckpointTurn({ stopReason: "answer", iterations: 2 });

    const raw = readFileSync(store.logFilePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    // Each record is exactly one physical line: the tool result and its marker
    // are NOT split across lines (an atomic commit unit for recovery).
    const completedLine = raw.find((l) => l.includes('"checkpoint_tool_completed"'));
    assert.ok(completedLine);
    const completed = JSON.parse(completedLine) as JsonRecord;
    const payload = completed.payload as {
      call_id: string;
      message: { role: string; call_id: string; text: string; is_error: boolean };
    };
    assert.equal(payload.call_id, "call-7");
    assert.deepEqual(payload.message, { role: "tool", call_id: "call-7", text: "written", is_error: false });

    const markerLine = raw.find((l) => l.includes('"checkpoint_turn_completed"'));
    assert.ok(markerLine);
    const marker = JSON.parse(markerLine) as JsonRecord;
    assert.deepEqual(marker.payload, { stop_reason: "answer", iterations: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trajectory_checkpoint records the full assistant message with wire tool_call blocks", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-log-"));
  try {
    const store = newStore(root);
    store.beginCheckpointTurn("do it", 1_700_000_000_000);
    store.appendCheckpointMessage({
      role: "assistant",
      content: [
        { type: "reasoning", text: "先看看" },
        { type: "tool-call", id: "call-01", name: "read_file", arguments: '{"path":"build.log"}' },
      ],
    });

    const record = readRecords(store.logFilePath).find((r) => r.type === "trajectory_checkpoint");
    assert.ok(record);
    const message = (record.payload as { message: Record<string, unknown> }).message;
    assert.equal(message.role, "assistant");
    assert.deepEqual(message.blocks, [
      { type: "reasoning", text: "先看看" },
      { type: "tool_call", id: "call-01", name: "read_file", arguments: '{"path":"build.log"}' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendTurn writes the full audit sequence with usage/cost and omits null cost", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-log-"));
  try {
    const store = newStore(root);
    const result: AgentResult = {
      answer: "我先查一下",
      trajectory: [
        { role: "user", content: [{ type: "text", text: "你好" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "我先查一下" },
            { type: "reasoning", text: "思考中" },
            { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"dir"}' },
          ],
        },
        { role: "tool", toolCallId: "c1", content: "目录内容", isError: false },
      ],
      history: [],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 },
      cost: { input: 0.1, output: 0.2, cacheRead: 0.07, cacheWrite: 0 },
      iterations: 1,
      stopReason: "answer",
    };
    store.appendTurn(result, 1_700_000_000_000);

    const records = readRecords(store.logFilePath);
    assert.deepEqual(
      records.map((r) => r.type),
      [
        "session_meta",
        "event_msg",
        "turn_context",
        "response_item",
        "response_item",
        "response_item",
        "response_item",
        "response_item",
        "event_msg",
      ],
    );
    const taskStarted = records[1]!.payload as Record<string, unknown>;
    assert.equal(taskStarted.type, "task_started");
    const user = records[3]!.payload as Record<string, unknown>;
    assert.deepEqual(user, { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] });
    const call = records[6]!.payload as Record<string, unknown>;
    assert.deepEqual(call, { type: "function_call", name: "bash", arguments: '{"command":"dir"}', call_id: "c1" });

    const complete = records[8]!.payload as Record<string, unknown>;
    assert.equal(complete.type, "task_complete");
    const cost = complete.cost as Record<string, unknown>;
    assert.equal(cost.input, 0.1);
    assert.equal(cost.output, 0.2);
    assert.equal(cost.cache_read, 0.07);
    assert.equal(cost.cache_write, 0);
    assert.ok(typeof cost.total === "number" && Math.abs(cost.total - 0.37) < 1e-9, `cost.total=${cost.total}`);
    const usage = complete.usage as Record<string, unknown>;
    assert.equal(usage.input_tokens, 100);
    assert.equal(usage.output_tokens, 50);
    assert.equal(usage.cache_read_tokens, 900);
    assert.equal(usage.cache_hit_rate, 0.9);

    // A turn without a cost omits the cost field entirely (never faked as zero).
    const noCost = new SessionStore({ rootDirectory: root });
    noCost.appendTurn({ ...result, cost: undefined }, 1_700_000_000_001);
    const noCostComplete = readRecords(noCost.logFilePath).find(
      (r) => r.type === "event_msg" && (r.payload as Record<string, unknown>).type === "task_complete",
    )!.payload as Record<string, unknown>;
    assert.ok(!("cost" in noCostComplete));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("appendFailure writes the task_failed sequence", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-log-"));
  try {
    const store = newStore(root);
    store.appendFailure("你好", "The response ended prematurely.", 1_700_000_000_000);

    const records = readRecords(store.logFilePath);
    assert.deepEqual(
      records.map((r) => r.type),
      ["session_meta", "event_msg", "turn_context", "response_item", "event_msg"],
    );
    const user = records[3]!.payload as Record<string, unknown>;
    assert.deepEqual(user, { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] });
    const failed = records[4]!.payload as Record<string, unknown>;
    assert.equal(failed.type, "task_failed");
    assert.equal(failed.error, "The response ended prematurely.");
    assert.ok(typeof failed.duration_ms === "number" && failed.duration_ms >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session ids are unique per instance", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-log-"));
  try {
    assert.notEqual(newStore(root).sessionId, newStore(root).sessionId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
