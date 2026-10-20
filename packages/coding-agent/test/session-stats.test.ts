import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentResult } from "@di/agent";
import { aggregateSessionStats, SessionStore } from "@di/coding-agent";

/**
 * P5 session stats (docs/migration/typescript-core/sessions-and-compatibility.md
 * §"审计型回合" + the stats gate "累计快照不会重复统计，未知字段不伪造已知"; C#
 * baseline `Core/Sessions/SessionStats.cs` `Aggregate`).
 *
 * Aggregation is per `task_complete` record, exactly once each: turns, token
 * counts, cost and duration are cumulative snapshots. Unknown/extra fields and
 * unknown record types are never faked into known counts; a malformed record is
 * skipped WHOLE (no partial totals); missing usage fields default to zero only
 * for token counts, never for cost; the cache hit rate is
 * cacheRead / (input + cacheRead + cacheWrite), null when no billable input.
 */

function writeLines(root: string, lines: string[]): string {
  const path = join(root, "handmade.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

test("aggregate sums a real session log exactly once per turn", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-stats-"));
  try {
    const store = new SessionStore({ rootDirectory: root });
    const result: AgentResult = {
      answer: "ok",
      trajectory: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      history: [],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 },
      cost: { input: 0.1, output: 0.2, cacheRead: 0.07, cacheWrite: 0 },
      iterations: 1,
      stopReason: "answer",
    };
    store.appendTurn(result, 1_700_000_000_000);
    store.appendTurn(result, 1_700_000_000_010);

    const stats = aggregateSessionStats(store.logFilePath);
    assert.equal(stats.turns, 2);
    assert.equal(stats.inputTokens, 200);
    assert.equal(stats.outputTokens, 100);
    assert.equal(stats.cacheReadTokens, 1800);
    assert.equal(stats.cacheWriteTokens, 0);
    assert.equal(stats.cacheHitRate, 0.9);
    assert.ok(stats.totalCost !== undefined && Math.abs(stats.totalCost - 0.74) < 1e-9, `totalCost=${stats.totalCost}`);
    assert.ok(stats.totalDurationMs !== undefined && stats.totalDurationMs >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a turn with no cost never fabricates cost, and missing usage tokens default to zero", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-stats-"));
  try {
    const path = writeLines(root, [
      '{"timestamp":"2026-10-13T00:00:00.000Z","ordinal":0,"type":"event_msg","payload":{"type":"task_complete","usage":{"input_tokens":7},"cost":{"total":0.25}}}',
      '{"timestamp":"2026-10-13T00:00:00.001Z","ordinal":1,"type":"event_msg","payload":{"type":"task_complete","usage":{"output_tokens":3}}}',
    ]);
    const stats = aggregateSessionStats(path);
    // The second turn's cost is absent -> totalCost stays 0.25, never faked as 0.28.
    assert.equal(stats.turns, 2);
    assert.equal(stats.inputTokens, 7);
    assert.equal(stats.outputTokens, 3);
    assert.equal(stats.totalCost, 0.25);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cache hit rate is cacheRead over billable input and null when no billable input", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-stats-"));
  try {
    const path = writeLines(root, [
      '{"timestamp":"2026-10-13T00:00:00.000Z","ordinal":0,"type":"event_msg","payload":{"type":"task_complete","usage":{"input_tokens":100,"output_tokens":50,"cache_read_tokens":900,"cache_write_tokens":100}}}',
    ]);
    const stats = aggregateSessionStats(path);
    assert.equal(stats.cacheHitRate, 900 / (100 + 900 + 100));

    const noInput = writeLines(root, [
      '{"timestamp":"2026-10-13T00:00:00.000Z","ordinal":0,"type":"event_msg","payload":{"type":"task_complete","usage":{}}}',
    ]);
    assert.equal(aggregateSessionStats(noInput).cacheHitRate, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid records are skipped whole with no partial totals", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-stats-"));
  try {
    const path = writeLines(root, [
      "这不是 JSON 行",
      '{"type":42}',
      '{"type":"event_msg","payload":{"type":"task_complete","usage":{"input_tokens":1.5}}}',
      '{"type":"event_msg","payload":{"type":"task_complete","duration_ms":1.5}}',
      '{"type":"event_msg","payload":{"type":"task_complete","usage":{"input_tokens":100},"cost":{"total":"bad"}}}',
      '{"type":"event_msg","payload":{"type":"task_complete","usage":{"input_tokens":100},"cost":{"total":1e400}}}',
      '{"type":"event_msg","payload":{"type":"task_complete","usage":{"input_tokens":7},"cost":{"total":0.25}}}',
    ]);
    const stats = aggregateSessionStats(path);
    assert.equal(stats.turns, 1);
    assert.equal(stats.inputTokens, 7);
    assert.equal(stats.totalCost, 0.25);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown record types and non-task-complete payloads are never counted as turns", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-stats-"));
  try {
    const path = writeLines(root, [
      '{"timestamp":"2026-10-13T00:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"session_id":"x"}}',
      '{"timestamp":"2026-10-13T00:00:00.000Z","ordinal":1,"type":"future_state_marker","payload":{}}',
      '{"timestamp":"2026-10-13T00:00:00.000Z","ordinal":2,"type":"event_msg","payload":{"type":"task_failed","error":"boom"}}',
      '{"timestamp":"2026-10-13T00:00:00.000Z","ordinal":3,"type":"event_msg","payload":{"type":"task_complete","usage":{"input_tokens":5}}}',
    ]);
    const stats = aggregateSessionStats(path);
    assert.equal(stats.turns, 1);
    assert.equal(stats.inputTokens, 5);
    assert.ok(!("fabricated" in stats));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no task_complete records yields zero turns and no invented aggregates", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-stats-"));
  try {
    const path = writeLines(root, [
      '{"timestamp":"2026-10-13T00:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"session_id":"x"}}',
    ]);
    const stats = aggregateSessionStats(path);
    assert.equal(stats.turns, 0);
    assert.equal(stats.inputTokens, 0);
    assert.equal(stats.cacheHitRate, undefined);
    assert.equal(stats.totalCost, undefined);
    assert.equal(stats.totalDurationMs, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing session file throws (IOException-equivalent)", () => {
  const root = mkdtempSync(join(tmpdir(), "di-session-stats-"));
  try {
    const missing = join(root, "no-such.jsonl");
    assert.throws(() => aggregateSessionStats(missing));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
