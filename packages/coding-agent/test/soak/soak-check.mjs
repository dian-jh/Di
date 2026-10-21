#!/usr/bin/env node
/**
 * P9-release-install-rollback — soak gate checker.
 *
 * Reads the frozen threshold manifest (docs/migration/typescript-core/probes/
 * P9-soak-manifest.json) plus a run's samples.jsonl and status.json, evaluates
 * every gate and prints PASS/FAIL per gate plus an overall verdict with the
 * exact observed numbers. Used at 10h completion; the manifest is frozen BEFORE
 * the soak and is never adjusted by results (validation-and-release.md §47-55).
 *
 * Gates (each threshold frozen in the manifest after the >=30-min warm-up):
 *   rss_max_delta_bytes   max(rss_bytes) - baseline rss <= delta
 *   handle_max_delta      last handle_count - baseline handle_count <= delta
 *   child_process_max     max(active_children) per sample <= this
 *   child_sustained_max   no 2 consecutive samples above this sustained level
 *   resume_p95_max_ms     p95(resume_parent_ms) <= this
 *   turn_fail_max         total failed turns == this (0 = none tolerated)
 *   resume_fail_max       total failed resume children == this (0 = none)
 *   wall_clock_min        completed wall-clock >= this (600 for the 10h gate)
 *
 * Usage:
 *   node soak-check.mjs --manifest <P9-soak-manifest.json> \
 *       --samples <samples.jsonl> --status <status.json>
 */

import { readFileSync, existsSync } from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    out[key] = next !== undefined && !next.startsWith("--") ? next : "true";
    if (next !== undefined && !next.startsWith("--")) i += 1;
  }
  return out;
}

function readJson(path) {
  if (!existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

const args = parseArgs(process.argv.slice(2));
const manifest = readJson(args.manifest);
const samples = readFileSync(args.samples, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const status = existsSync(args.status) ? readJson(args.status) : {};

if (samples.length === 0) throw new Error("samples.jsonl is empty");

const baseline = samples[0];
const rssMax = Math.max(...samples.map((s) => s.rss_bytes));
const rssMaxDelta = rssMax - (baseline.rss_bytes ?? 0);
const handleBaseline = baseline.handle_count ?? 0;
const handleLast = samples[samples.length - 1].handle_count ?? 0;
const handleDelta = handleLast - handleBaseline;
const childMax = Math.max(...samples.map((s) => s.active_children ?? 0));
const sustained = new Set([...new Set(samples.map((s) => s.active_children ?? 0))]);
const resumeMs = samples.filter((s) => typeof s.last_resume_ms === "number").map((s) => s.last_resume_ms);
const resumeP95 =
  resumeMs.length > 0
    ? [...resumeMs].sort((a, b) => a - b)[Math.floor(resumeMs.length * 0.95)]
    : 0;
const turnFail = status.turnFail ?? samples[samples.length - 1].turn_fail ?? 0;
const resumeSpawns = status.resumeSpawns ?? samples[samples.length - 1]?.turns_done ?? 0;
const resumeOk = status.resumeOk ?? 0;
const resumeFail = resumeSpawns - resumeOk;
const wallMin = status.wallClockMs ? Math.round(status.wallClockMs / 60000) : 0;

const results = [
  {
    gate: "rss_max_delta_bytes",
    threshold: manifest.thresholds.rss_max_delta_bytes,
    observed: rssMaxDelta,
    pass: rssMaxDelta <= manifest.thresholds.rss_max_delta_bytes,
  },
  {
    gate: "handle_max_delta",
    threshold: manifest.thresholds.handle_max_delta,
    observed: handleDelta,
    pass: handleDelta <= manifest.thresholds.handle_max_delta,
  },
  {
    gate: "child_process_max",
    threshold: manifest.thresholds.child_process_max,
    observed: childMax,
    pass: childMax <= manifest.thresholds.child_process_max,
  },
  {
    gate: "child_sustained_max",
    threshold: manifest.thresholds.child_sustained_max,
    observed: `levels=${[...sustained].sort((a, b) => a - b).join(",")}`,
    pass: samples.every(
      (s, i) =>
        i === 0 ||
        !((s.active_children ?? 0) > manifest.thresholds.child_sustained_max &&
          (samples[i - 1].active_children ?? 0) > manifest.thresholds.child_sustained_max),
    ),
  },
  {
    gate: "resume_p95_max_ms",
    threshold: manifest.thresholds.resume_p95_max_ms,
    observed: resumeP95,
    pass: resumeP95 <= manifest.thresholds.resume_p95_max_ms,
  },
  {
    gate: "turn_fail_max",
    threshold: manifest.thresholds.turn_fail_max,
    observed: turnFail,
    pass: turnFail <= manifest.thresholds.turn_fail_max,
  },
  {
    gate: "resume_fail_max",
    threshold: manifest.thresholds.resume_fail_max,
    observed: resumeFail,
    pass: resumeFail <= manifest.thresholds.resume_fail_max,
  },
  {
    gate: "wall_clock_min",
    threshold: manifest.thresholds.wall_clock_min,
    observed: wallMin,
    pass: wallMin >= manifest.thresholds.wall_clock_min,
  },
];

console.log(`soak-check for run ${status.runId ?? "?"} (${samples.length} samples, ${samples[samples.length - 1].ts_utc})`);
let overall = true;
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  if (!r.pass) overall = false;
  console.log(`  [${tag}] ${r.gate}: observed=${r.observed} threshold=${r.threshold}`);
}
if (status.completed === false) {
  overall = false;
  console.log(`  [FAIL] status.completed=false (harness did not run the full wall-clock)`);
}
console.log(overall ? "OVERALL: PASS" : "OVERALL: FAIL");
process.exitCode = overall ? 0 : 1;
