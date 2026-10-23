#!/usr/bin/env node
/**
 * Reads the frozen threshold manifest in docs/soak-thresholds.json and evaluates
 * every gate and prints PASS/FAIL per gate plus an overall verdict with the
 * exact observed numbers. Used at 10h completion; the manifest is frozen BEFORE
 * the soak and is never adjusted by results (docs/typescript-validation.md §47-55).
 *
 * Gates (each threshold frozen in the manifest after the >=30-min warm-up):
 *   rss_max_delta_bytes   max(rss_bytes) - baseline rss <= delta
 *   rss_monotonic         max(rss over last 2h) - max(rss over first 2h) <= delta
 *   handle_max_delta      max(handle_count) - baseline handle_count <= delta
 *   os_handle_max_delta   optional: max(os_handle_count) - baseline <= delta; missing samples fail
 *   child_process_max     max(active_children) per sample <= this
 *   child_sustained_max   no 2 consecutive samples above this sustained level
 *
 *   turn_fail_max         total failed turns == this (0 = none tolerated)
 *   resume_fail_max       total failed resume children == this (0 = none)
 *   wall_clock_min        completed wall-clock >= this (600 for the 10h gate)
 *
 * Usage:
 *
 *   node soak-check.mjs --manifest <docs/soak-thresholds.json> \
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
const defaultManifest = new URL("../../../../docs/soak-thresholds.json", import.meta.url);
const manifest = readJson(args.manifest ?? defaultManifest);
const samples = readFileSync(args.samples, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const statusAvailable = args.status !== undefined && existsSync(args.status);
const status = statusAvailable ? readJson(args.status) : {};

if (samples.length === 0) throw new Error("samples.jsonl is empty");

const baseline = samples[0];
const rssMax = Math.max(...samples.map((s) => s.rss_bytes));
const rssMaxDelta = rssMax - (baseline.rss_bytes ?? 0);
const handleBaseline = baseline.handle_count ?? 0;
const handleMax = Math.max(...samples.map((s) => s.handle_count ?? 0));
const handleDelta = handleMax - handleBaseline;
const osHandleGate = Object.hasOwn(manifest.thresholds, "os_handle_max_delta")
  ? (() => {
      const counts = samples.map((s) => s.os_handle_count);
      const threshold = manifest.thresholds.os_handle_max_delta;
      if (!Number.isFinite(threshold) || counts.some((n) => !Number.isInteger(n) || n < 0)) {
        return { threshold, observed: "unknown (OS handle samples missing)", pass: false };
      }
      return {
        threshold,
        observed: Math.max(...counts) - counts[0],
        pass: Math.max(...counts) - counts[0] <= threshold,
      };
    })()
  : null;
const childMax = Math.max(...samples.map((s) => s.active_children ?? 0));
const sustained = new Set([...new Set(samples.map((s) => s.active_children ?? 0))]);
const resumeMs = samples.filter((s) => typeof s.last_resume_ms === "number").map((s) => s.last_resume_ms);
const resumeP95 =
  resumeMs.length > 0
    ? [...resumeMs].sort((a, b) => a - b)[Math.floor(resumeMs.length * 0.95)]
    : 0;
// Monotonic-growth criterion (docs/typescript-validation.md 53: "多个采样窗口单调增长").
// Compare max RSS over the first vs last 2h of samples; drift beyond the frozen
// rss delta is a gate failure even when the absolute max is still under budget.
const first2hMax = Math.max(...samples.filter((s) => s.uptime_ms <= 2 * 3600_000).map((s) => s.rss_bytes));
const last2hMax = Math.max(
  ...samples.filter((s) => s.uptime_ms >= (samples[samples.length - 1].uptime_ms - 2 * 3600_000)).map((s) => s.rss_bytes),
);
const turnFail = status.turnFail ?? samples[samples.length - 1].turn_fail ?? 0;
const resumeCountsAvailable =
  Number.isInteger(status.resumeSpawns) && Number.isInteger(status.resumeOk) && status.resumeOk <= status.resumeSpawns;
const resumeFail = resumeCountsAvailable ? status.resumeSpawns - status.resumeOk : undefined;
const wallClockMs = Number.isFinite(status.wallClockMs) ? status.wallClockMs : undefined;
const wallClockThresholdMs = manifest.thresholds.wall_clock_min * 60_000;

const results = [
  {
    gate: "status_file",
    threshold: "present",
    observed: statusAvailable ? "present" : "missing",
    pass: statusAvailable,
  },
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
  ...(osHandleGate === null ? [] : [{
    gate: "os_handle_max_delta",
    threshold: osHandleGate.threshold,
    observed: osHandleGate.observed,
    pass: osHandleGate.pass,
  }]),
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
    gate: "rss_monotonic",
    threshold: manifest.thresholds.rss_max_delta_bytes,
    observed: `first2hMax=${first2hMax} last2hMax=${last2hMax}`,
    pass: last2hMax - first2hMax <= manifest.thresholds.rss_max_delta_bytes,
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
    observed: resumeCountsAvailable ? resumeFail : "unknown (status counters missing)",
    pass: resumeCountsAvailable && resumeFail <= manifest.thresholds.resume_fail_max,
  },
  {
    gate: "wall_clock_min",
    threshold: `${wallClockThresholdMs}ms`,
    observed: wallClockMs === undefined ? "unknown (status wallClockMs missing)" : `${wallClockMs}ms`,
    pass: wallClockMs !== undefined && Number.isFinite(wallClockThresholdMs) && wallClockMs >= wallClockThresholdMs,
  },
];

console.log(`soak-check for run ${status.runId ?? "?"} (${samples.length} samples, ${samples[samples.length - 1].ts_utc})`);
let overall = true;
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  if (!r.pass) overall = false;
  console.log(`  [${tag}] ${r.gate}: observed=${r.observed} threshold=${r.threshold}`);
}
if (statusAvailable && status.completed === false) {
  overall = false;
  console.log(`  [FAIL] status.completed=false (harness did not run the full wall-clock)`);
}
console.log(overall ? "OVERALL: PASS" : "OVERALL: FAIL");
process.exitCode = overall ? 0 : 1;
