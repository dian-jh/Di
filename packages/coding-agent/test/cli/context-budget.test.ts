import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolCall } from "@di/ai";
import type { ToolExecutor } from "@di/agent";
import { BudgetPolicy, CompactingExecutor, FileArtifactStore, type ArtifactStore } from "@di/coding-agent";
import { OUTPUT_MAX_CHARS } from "@di/coding-agent";

test("BudgetPolicy mirrors configured reserves, clamping, waterlines and prediction", () => {
  const policy = new BudgetPolicy(100_000, {
    marginRatio: 0.1,
    outputReserveTokens: 20_000,
    nextOutputReserveTokens: 500,
  });
  assert.equal(policy.inputBudget, 70_000);
  assert.equal(policy.softThreshold, 49_000);
  assert.equal(policy.hardThreshold, 56_000);
  assert.equal(policy.blockingThreshold, 63_000);
  assert.equal(policy.waterlineFor(49_000), "soft");
  assert.equal(policy.predictsOverSoft(40_000, 8_499), false);
  assert.equal(policy.predictsOverSoft(40_000, 8_500), true);
  assert.equal(new BudgetPolicy(1_000).inputBudget, 0);
  assert.equal(new BudgetPolicy(5, { marginRatio: 0.1, outputReserveTokens: 0 }).marginTokens, 0, "C# midpoint rounding is ties-to-even");
  assert.throws(() => new BudgetPolicy(10, { softRatio: 0.9, hardRatio: 0.8 }));
});

test("CompactingExecutor persists only oversized allowlisted output at predicted soft line and fails safe", async () => {
  const root = mkdtempSync(join(tmpdir(), "di-context-"));
  try {
    const store = new FileArtifactStore(root, () => new Date("2026-10-21T12:00:00.000Z"), () => 1);
    const oversized = "H".repeat(OUTPUT_MAX_CHARS / 2) + "M".repeat(OUTPUT_MAX_CHARS) + "T".repeat(OUTPUT_MAX_CHARS / 2);
    const inner: ToolExecutor = { execute: async () => ({ text: oversized, isError: false }) };
    const executor = new CompactingExecutor(inner, store, () => new BudgetPolicy(100_000, { outputReserveTokens: 0, marginRatio: 0 }), () => 69_999);
    const call: ToolCall = { type: "tool-call", id: "c1", name: "read_file", arguments: "{}" };
    const result = await executor.execute(call);
    assert.ok(result.text.length < oversized.length);
    assert.match(result.text, /已保存到/);
    const artifactPath = result.text.match(/已保存到 (.+)，可用 read_file/)?.[1];
    assert.ok(artifactPath);
    assert.equal(readFileSync(artifactPath, "utf8"), oversized);

    const almostPreview = "x".repeat(OUTPUT_MAX_CHARS + 1);
    const reclaiming = new CompactingExecutor({ execute: async () => ({ text: almostPreview, isError: false }) }, store, () => new BudgetPolicy(100_000, { outputReserveTokens: 0, marginRatio: 0 }), () => 69_999);
    assert.equal((await reclaiming.execute(call)).text, almostPreview);
    const artifactFiles = readdirSync(join(root, "sessions", "2026", "10", "21", "artifacts"));
    assert.equal(artifactFiles.length, 1, "non-shrinking summary artifact is reclaimed");
    assert.ok(existsSync(artifactPath));
    const secondStore = new FileArtifactStore(root, () => new Date("2026-10-21T12:00:00.000Z"), () => 1);
    const secondPath = secondStore.write("read_file", "second instance");
    assert.notEqual(secondPath, artifactPath, "separate stores in one process share the collision counter");

    const writer = new CompactingExecutor(inner, store, () => new BudgetPolicy(100_000), () => 99_000);
    assert.equal((await writer.execute({ ...call, name: "write_file" })).text, oversized);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CompactingExecutor passes through small output, unknown policy and a known policy below soft", async () => {
  let writes = 0;
  const store: ArtifactStore = { write: () => { writes += 1; return "unused"; } };
  const result = { text: "small", isError: false };
  const inner: ToolExecutor = { execute: async () => result };
  const call: ToolCall = { type: "tool-call", id: "c2", name: "read_file", arguments: "{}" };
  const noPolicy = new CompactingExecutor(inner, store, () => undefined, () => 1_000_000);
  assert.equal(await noPolicy.execute(call), result);
  const underSoft = new CompactingExecutor(inner, store, () => new BudgetPolicy(100_000), () => 0);
  assert.equal(await underSoft.execute(call), result);
  assert.equal(writes, 0);
});

test("CompactingExecutor fails safe when artifact writing throws", async () => {
  const oversized = "body".repeat(OUTPUT_MAX_CHARS);
  const errorObservation = { text: oversized, isError: true };
  const inner: ToolExecutor = { execute: async () => errorObservation };
  const brokenStore: ArtifactStore = { write: () => { throw new Error("disk unavailable"); } };
  const executor = new CompactingExecutor(inner, brokenStore, () => new BudgetPolicy(100_000, { outputReserveTokens: 0, marginRatio: 0 }), () => 69_999);
  const result = await executor.execute({ type: "tool-call", id: "c3", name: "grep", arguments: "{}" });
  assert.equal(result.text, oversized);
  assert.equal(result.isError, true);
});

test("CompactingExecutor compacts error observations without changing their error flag", async () => {
  const root = mkdtempSync(join(tmpdir(), "di-context-error-"));
  try {
    const errorText = "error: diagnostic\n" + "x".repeat(OUTPUT_MAX_CHARS * 2);
    const inner: ToolExecutor = { execute: async () => ({ text: errorText, isError: true }) };
    const store = new FileArtifactStore(root, () => new Date("2026-10-21T12:00:00.000Z"), () => 2);
    const executor = new CompactingExecutor(inner, store, () => new BudgetPolicy(100_000, { outputReserveTokens: 0, marginRatio: 0 }), () => 69_999);
    const result = await executor.execute({ type: "tool-call", id: "c4", name: "grep", arguments: "{}" });
    assert.equal(result.isError, true);
    assert.ok(result.text.length < errorText.length);
    const artifactPath = result.text.match(/已保存到 (.+)，可用 read_file/)?.[1];
    assert.ok(artifactPath);
    assert.equal(readFileSync(artifactPath, "utf8"), errorText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
