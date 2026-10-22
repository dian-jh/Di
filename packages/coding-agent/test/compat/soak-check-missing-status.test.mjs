import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const checker = join(repo, "packages/coding-agent/test/soak/soak-check.mjs");

test("missing soak status is an explicit failure and does not invent resume failures", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "di-soak-check-missing-status-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const manifest = join(temp, "manifest.json");
  const samples = join(temp, "samples.jsonl");
  writeFileSync(manifest, JSON.stringify({ thresholds: {
    rss_max_delta_bytes: 20, handle_max_delta: 8, child_process_max: 1,
    child_sustained_max: 0, resume_p95_max_ms: 60_000, turn_fail_max: 0,
    resume_fail_max: 0, wall_clock_min: 600,
  } }));
  writeFileSync(samples, `${JSON.stringify({ uptime_ms: 0, rss_bytes: 100, turns_done: 99 })}\n`);
  const result = spawnSync(process.execPath, [checker, "--manifest", manifest, "--samples", samples, "--status", join(temp, "missing-status.json")], {
    cwd: repo, encoding: "utf8",
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /status_file.*observed=missing/i);
  assert.match(result.stdout, /resume_fail_max.*observed=unknown/i);
  assert.doesNotMatch(result.stdout, /resume_fail_max.*observed=99\b/);
});
