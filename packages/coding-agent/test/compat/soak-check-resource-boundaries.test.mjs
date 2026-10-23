import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const checker = join(repo, "packages/coding-agent/test/soak/soak-check.mjs");

function runCheck(root, { wallClockMs, handles, osHandles, osHandleMaxDelta }) {
  const manifestPath = join(root, "manifest.json");
  const samplesPath = join(root, "samples.jsonl");
  const statusPath = join(root, "status.json");
  writeFileSync(manifestPath, JSON.stringify({ thresholds: {
    rss_max_delta_bytes: 20, handle_max_delta: 8, child_process_max: 1,
    child_sustained_max: 0, resume_p95_max_ms: 60_000, turn_fail_max: 0,
    resume_fail_max: 0, wall_clock_min: 600,
    ...(osHandleMaxDelta === undefined ? {} : { os_handle_max_delta: osHandleMaxDelta }),
  } }));
  const samples = handles.map((handle_count, index) => ({
    ts_utc: `2026-10-23T0${index}:00:00.000Z`, uptime_ms: index * 30_000,
    rss_bytes: 100, handle_count, active_children: 0, turn_fail: 0,
    ...(osHandles === undefined ? {} : { os_handle_count: osHandles[index] }),
  }));
  writeFileSync(samplesPath, `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`);
  writeFileSync(statusPath, JSON.stringify({
    runId: "boundary-test", completed: true, wallClockMs, turnFail: 0, resumeSpawns: 0, resumeOk: 0,
  }));
  return spawnSync(process.execPath, [checker, "--manifest", manifestPath, "--samples", samplesPath, "--status", statusPath], {
    cwd: repo, encoding: "utf8",
  });
}

test("soak checker rejects a transient OS handle peak even when the final sample returns to baseline", (t) => {
  const root = mkdtempSync(join(tmpdir(), "di-soak-check-handle-peak-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runCheck(root, { wallClockMs: 600 * 60_000, handles: [100, 120, 100] });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[FAIL\] handle_max_delta: observed=20 threshold=8/);
});

test("soak checker rejects a run one millisecond short of the frozen wall-clock minimum", (t) => {
  const root = mkdtempSync(join(tmpdir(), "di-soak-check-wall-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runCheck(root, { wallClockMs: 600 * 60_000 - 1, handles: [100, 100] });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[FAIL\] wall_clock_min: observed=35999999ms threshold=36000000ms/);
});

test("soak checker accepts exactly the frozen wall-clock minimum with stable handles", (t) => {
  const root = mkdtempSync(join(tmpdir(), "di-soak-check-wall-exact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runCheck(root, { wallClockMs: 600 * 60_000, handles: [100, 100] });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[PASS\] handle_max_delta: observed=0 threshold=8/);
  assert.match(result.stdout, /\[PASS\] wall_clock_min: observed=36000000ms threshold=36000000ms/);
  assert.doesNotMatch(result.stdout, /os_handle_max_delta/);
});

test("configured OS handle gate fails when any required sample is unavailable", (t) => {
  const root = mkdtempSync(join(tmpdir(), "di-soak-check-os-handles-missing-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runCheck(root, {
    wallClockMs: 600 * 60_000, handles: [100, 100], osHandles: [200, null], osHandleMaxDelta: 8,
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[FAIL\] os_handle_max_delta: observed=unknown \(OS handle samples missing\) threshold=8/);
});

test("configured OS handle gate measures peak growth from the baseline", (t) => {
  const root = mkdtempSync(join(tmpdir(), "di-soak-check-os-handle-peak-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runCheck(root, {
    wallClockMs: 600 * 60_000, handles: [100, 100, 100], osHandles: [200, 220, 200], osHandleMaxDelta: 8,
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\[FAIL\] os_handle_max_delta: observed=20 threshold=8/);
});
