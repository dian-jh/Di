#!/usr/bin/env node
/**
 *
 * Drives the REAL production composition root (createCliHost -> the same
 * AgentSession runner that `di-ts` print/json/rpc modes drive) in an isolated
 * temp DI_HOME with a local deterministic fake ChatModel + fake tool. No real
 * provider, no network, no credentials. Each turn: the fake model emits a
 * tool-call to `soak_child`, the tool spawns and terminates a REAL child
 * process (natural exit on most turns, force-kill every 3rd), then the model
 * emits the final text and the loop persists the checkpoint.
 *
 * Every sample interval it records RSS / heap / active handles / active child
 * processes / turn success-fail / model iterations / checkpoint bytes+lines.
 * Every N turns it spawns a NEW child process that loads the parent's session
 * checkpoint (real resume/reload) and measures resume latency. Periodically it
 * exercises the /clear interface (runner.resetHistory). 10h completion must be
 * real wall-clock — this harness never derives pass from iteration counts.
 *
 * Usage:
 *   node soak-runner.mjs run --di-home <dir> --workspace <dir>
 *       --duration-min <n> --sample-interval-sec <n>
 *       --resume-every-turns <n> --clear-every-turns <n>
 *       --turn-delay-ms <n> --out <dir> [--phase <label>]
 *   node soak-runner.mjs child --di-home <dir> --workspace <dir>
 *       --session <file> --out <dir>          # resume child; prints RESUMED <ms>
 */

import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCliHost, DiHome } from "@di/coding-agent";
import { makeCheckpointTracker } from "./checkpoint-tracker.mjs";
import { sampleProcessMetrics } from "./process-metrics.mjs";
import { runResumeChild } from "./resume-child.mjs";
import { validateSoakPaths } from "./soak-path-validation.mjs";

const HERE_FILE = fileURLToPath(import.meta.url);
const HERE_DIR = dirname(HERE_FILE);

function sourceProvenance(workspace) {
  const git = (args) => {
    try { return execFileSync("git", args, { cwd: workspace, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { return null; }
  };
  const gitSha = git(["rev-parse", "HEAD"]);
  const dirtyPaths = (git(["status", "--porcelain"]) ?? "").split("\n").filter(Boolean);
  return { gitSha, dirty: dirtyPaths.length > 0, dirtyPaths };
}

/** Short-lived child payloads: exit naturally (25ms) or park and get killed (30s). */
const EXIT_CODE = "setTimeout(()=>{}, 25)";
const KILL_CODE = "setTimeout(()=>{}, 30000)";

/** Global child-process accounting so residual/leaked children are visible. */
const childState = { created: 0, exited: 0, resumeCreated: 0, resumeExited: 0 };
const activeChildren = () => childState.created - childState.exited;
const activeResumeChildren = () => childState.resumeCreated - childState.resumeExited;

/** Deterministic fake ChatModel: alternate tool-call / final-text across calls. */
class FakeModel {
  constructor() {
    this.callCount = 0;
  }

  stream(request, _signal) {
    this.callCount += 1;
    const n = this.callCount;
    const toolCall = n % 2 === 1;
    const content = toolCall
      ? [
          {
            type: "tool-call",
            id: `soak-${n}`,
            name: "soak_child",
            arguments: JSON.stringify({ mode: n % 3 === 0 ? "kill" : "exit" }),
          },
        ]
      : [{ type: "text", text: `soak turn done (call ${n})` }];
    const response = {
      message: { role: "assistant", content },
      finishReason: toolCall ? { type: "tool-calls" } : { type: "stop" },
      usage: { inputTokens: 40, outputTokens: 8 },
      model: "soak-fake",
      timestamp: Date.now(),
    };
    return (async function* () {
      yield { type: "completed", response };
    })();
  }
}

/** Spawn one real child process and resolve the tool observation on its exit. */
function spawnChild(kind) {
  childState.created += 1;
  return new Promise((resolveObs) => {
    let child;
    const failsafe = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, 5000);
    try {
      child = spawn(process.execPath, ["-e", kind === "kill" ? KILL_CODE : EXIT_CODE], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (err) {
      clearTimeout(failsafe);
      childState.exited += 1;
      resolveObs({ text: `error: ${err.message}`, isError: true });
      return;
    }
    if (kind === "kill") {
      // Force-kill after a short grace: real process termination on this turn.
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, 40);
    }
    child.on("exit", (code, signal) => {
      clearTimeout(failsafe);
      childState.exited += 1;
      resolveObs({ text: `exit: ${code} signal: ${signal ?? ""}`, isError: false });
    });
    child.on("error", (err) => {
      clearTimeout(failsafe);
      childState.exited += 1;
      resolveObs({ text: `error: ${err.message}`, isError: true });
    });
  });
}

/** Fake tool: spawn+terminate a real child process, report its exit code. */
const fakeTool = {
  spec: {
    name: "soak_child",
    description: "spawn and terminate a short-lived child process, report its exit code",
    parameters: {
      type: "object",
      properties: { mode: { type: "string", enum: ["exit", "kill"] } },
      required: ["mode"],
    },
  },
  promptSnippet: "soak_child: spawn+terminate a child, report exit",
  promptGuidelines: [],
  async execute(argsJson, _signal) {
    try {
      const parsed = JSON.parse(argsJson);
      return await spawnChild(parsed && parsed.mode === "kill" ? "kill" : "exit");
    } catch (err) {
      return { text: `error: ${err.message}`, isError: true };
    }
  },
};

/** In-memory advisory model service (no network, no credentials). */
function fakeModelService() {
  return {
    listProviders: () => [{ id: "soak", name: "Soak Fake" }],
    listModels: () => [],
    refreshModels: async () => [],
    checkAuth: async () => false,
    resolveModel: async (provider, id) => ({ provider, id, name: id }),
  };
}

function stringWriter(prefix) {
  return {
    write: (t) => process.stderr.write(`${prefix}${t}`),
    writeLine: (t = "") => process.stderr.write(`${prefix}${t}\n`),
  };
}

/** Build the real host (same composition root the production CLI drives). */
async function buildHost(diHomeDir, workspace, resumePath) {
  const model = new FakeModel();
  const diHome = DiHome.fromDirectory(diHomeDir);
  const host = await createCliHost(
    { resume: resumePath, noSession: false },
    workspace,
    stringWriter("[host] "),
    false,
    {
      diHome,
      modelFactory: () => model,
      modelService: fakeModelService(),
      tools: [fakeTool],
      skills: [],
    },
  );
  return { host, model };
}

/** Read the N trailing bytes of a file (for error/summary dumps). */
function tail(path, n) {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  const start = Math.max(0, size - n);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const r = readSync(fd, buf, got, buf.length - got, start + got);
      if (r === 0) break;
      got += r;
    }
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (["di-home", "out", "workspace"].includes(key) && (next === undefined || next.startsWith("--"))) {
      throw new Error(`--${key} requires a non-empty path value before the next option`);
    }
    out[key] = next !== undefined && !next.startsWith("--") ? next : "true";
    if (next !== undefined && !next.startsWith("--")) i += 1;
  }
  return out;
}

function int(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** The resume child: load the parent checkpoint, run one turn, print RESUMED. */
async function childPhase(args) {
  const t0 = performance.now();
  const resumePath = args.session;
  try {
    const { host } = await buildHost(args["di-home"], args.workspace, resumePath);
    let stop = "?";
    try {
      const result = await host.runner.runTurn("soak resume turn");
      stop = String(result.stopReason);
    } finally {
      host.dispose();
    }
    const ms = performance.now() - t0;
    console.log(`RESUMED ${Math.round(ms)} stop=${stop}`);
    return 0;
  } catch (err) {
    console.log(`RESUME_FAIL ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** The main soak loop (warm-up and full 10h run both use this). */
async function runPhase(args) {
  const diHome = args["di-home"];
  const workspace = args.workspace;
  const out = args.out;
  const durationMin = int(args["duration-min"], 600);
  const sampleIntervalMs = int(args["sample-interval-sec"], 30) * 1000;
  const resumeEvery = int(args["resume-every-turns"], 0);
  const clearEvery = int(args["clear-every-turns"], 0);
  const turnDelayMs = int(args["turn-delay-ms"], 200);
  const phase = args.phase ?? "soak";

  mkdirSync(out, { recursive: true });
  const csvPath = join(out, "samples.csv");
  const jsonlPath = join(out, "samples.jsonl");
  const runJsonPath = join(out, "run.json");
  const statusJsonPath = join(out, "status.json");

  const { host, model } = await buildHost(diHome, workspace, undefined);
  const store = host.sessionStore;
  const checkpointPath = store?.logFilePath;
  const runner = host.runner;

  const runId = args["run-id"] ?? `soak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const start = Date.now();
  const deadline = start + durationMin * 60_000;
  const runInfo = {
    runId,
    pid: process.pid,
    startUtc: new Date(start).toISOString(),
    deadlineUtc: new Date(deadline).toISOString(),
    phase,
    durationMin,
    sampleIntervalSec: sampleIntervalMs / 1000,
    resumeEveryTurns: resumeEvery,
    clearEveryTurns: clearEvery,
    turnDelayMs,
    diHome,
    workspace,
    out,
    checkpointPath,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    ...sourceProvenance(workspace),
    model: "soak-fake (deterministic, no real provider)",
  };
  writeFileSync(runJsonPath, JSON.stringify(runInfo, null, 2));
  process.stderr.write(`[soak] runId=${runId} pid=${process.pid} start=${runInfo.startUtc} durationMin=${durationMin}\n`);
  process.stderr.write(`[soak] checkpoint=${checkpointPath}\n`);

  const ctx = {
    start,
    model,
    csv: csvPath,
    jsonl: jsonlPath,
    checkpointPath,
    phase,
    turns: 0,
    ok: 0,
    fail: 0,
    cleared: 0,
    lastResumeMs: undefined,
    lastResumeHandshakeMs: undefined,
    lastResumeChildMs: undefined,
    unreapedResumePid: undefined,
    resumeSpawns: 0,
    resumeOk: 0,
    lastError: undefined,
  };

  if (!existsSync(csvPath)) {
    writeFileSync(
      csvPath,
      "ts_utc,uptime_ms,rss_bytes,heap_used,external_bytes,array_buffers_bytes,handle_count,js_handle_count,os_handle_count,working_set_bytes,peak_working_set_bytes,private_bytes,native_metrics_error,v8_total_heap_size_bytes,v8_total_physical_size_bytes,v8_malloced_memory_bytes,v8_peak_malloced_memory_bytes,active_children,children_created,children_exited,active_resume_children,resume_children_created,resume_children_exited,turns_done,turn_ok,turn_fail,iterations,checkpoint_bytes,checkpoint_lines,last_resume_ms,last_resume_handshake_ms,cleared\n",
    );
  }

  const tracker = makeCheckpointTracker();
  const sample = () => {
    const now = Date.now();
    const processMetrics = sampleProcessMetrics();
    const mem = process.memoryUsage();
    const handles = typeof process._getActiveHandles === "function" ? process._getActiveHandles().length : -1;
    const cp = tracker(ctx.checkpointPath);
    const row = {
      ts_utc: new Date(now).toISOString(),
      uptime_ms: now - ctx.start,
      rss_bytes: mem.rss,
      heap_used: mem.heapUsed,
      external_bytes: mem.external,
      array_buffers_bytes: mem.arrayBuffers,
      handle_count: handles,
      ...processMetrics,
      active_children: activeChildren(),
      children_created: childState.created,
      children_exited: childState.exited,
      active_resume_children: activeResumeChildren(),
      resume_children_created: childState.resumeCreated,
      resume_children_exited: childState.resumeExited,
      turns_done: ctx.turns,
      turn_ok: ctx.ok,
      turn_fail: ctx.fail,
      iterations: model.callCount,
      checkpoint_bytes: cp.bytes,
      checkpoint_lines: cp.lines,
      last_resume_ms: ctx.lastResumeMs ?? "",
      last_resume_handshake_ms: ctx.lastResumeHandshakeMs ?? "",
      cleared: ctx.cleared,
      phase: ctx.phase,
    };
    const csvLine = [
      row.ts_utc,
      row.uptime_ms,
      row.rss_bytes,
      row.heap_used,
      row.external_bytes,
      row.array_buffers_bytes,
      row.handle_count,
      row.js_handle_count,
      row.os_handle_count,
      row.working_set_bytes,
      row.peak_working_set_bytes,
      row.private_bytes,
      row.native_metrics_error ?? "",
      row.v8_total_heap_size_bytes,
      row.v8_total_physical_size_bytes,
      row.v8_malloced_memory_bytes,
      row.v8_peak_malloced_memory_bytes,
      row.active_children,
      row.children_created,
      row.children_exited,
      row.active_resume_children,
      row.resume_children_created,
      row.resume_children_exited,
      row.turns_done,
      row.turn_ok,
      row.turn_fail,
      row.iterations,
      row.checkpoint_bytes,
      row.checkpoint_lines,
      row.last_resume_ms,
      row.last_resume_handshake_ms,
      row.cleared,
    ].join(",");
    appendFileSync(ctx.csv, csvLine + "\n");
    appendFileSync(ctx.jsonl, JSON.stringify(row) + "\n");
    process.stderr.write(
      `[soak ${row.ts_utc}] rss=${(row.rss_bytes / 1048576).toFixed(1)}MB heap=${(row.heap_used / 1048576).toFixed(1)}MB ` +
        `handles=${row.handle_count}/js:${row.js_handle_count}/os:${row.os_handle_count ?? "null"} ` +
        `workingSet=${row.working_set_bytes ?? "null"} private=${row.private_bytes ?? "null"} ` +
        `children=${row.active_children}(${row.children_created}/${row.children_exited}) ` +
        `turns=${row.turns_done} ok=${row.turn_ok} fail=${row.turn_fail} iter=${row.iterations} ` +
        `cp=${row.checkpoint_bytes}B/${row.checkpoint_lines}L resume=${row.last_resume_ms ?? "-"} cleared=${row.cleared}\n`,
    );
  };

  /** Spawn a fresh resume child, measure handshake/total latency, and wait for close. */
  const doResume = async () => {
    const result = await runResumeChild({
      spawn: () => spawn(
        process.execPath,
        [HERE_FILE, "child", "--di-home", diHome, "--workspace", workspace, "--session", checkpointPath, "--out", out],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      ),
      childState,
    });
    ctx.resumeSpawns += 1;
    ctx.lastResumeMs = Math.round(result.parentMs);
    ctx.lastResumeHandshakeMs = result.handshakeMs === null ? null : Math.round(result.handshakeMs);
    ctx.lastResumeChildMs = result.childMs;
    if (result.ok) ctx.resumeOk += 1;
    else ctx.lastError = result.message;
    return result;
  };

  sample(); // t=0 baseline sample
  let nextSampleAt = ctx.start + sampleIntervalMs;
  try {
    while (Date.now() < deadline) {
      try {
        await runner.runTurn(`soak turn ${ctx.turns + 1}`);
        ctx.ok += 1;
      } catch (err) {
        ctx.fail += 1;
        ctx.lastError = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[soak] turn ${ctx.turns + 1} failed: ${ctx.lastError}\n`);
      }
      ctx.turns += 1;

      if (turnDelayMs > 0) await new Promise((r) => setTimeout(r, turnDelayMs));

      if (clearEvery > 0 && ctx.turns % clearEvery === 0) {
        runner.resetHistory();
        ctx.cleared += 1;
      }
      if (resumeEvery > 0 && ctx.turns % resumeEvery === 0) {
        const resumeResult = await doResume();
        if (resumeResult.spawned && !resumeResult.closed) {
          ctx.unreapedResumePid = resumeResult.pid;
          break; // do not accumulate more processes after a failed reap
        }
      }
      if (Date.now() >= nextSampleAt) {
        sample();
        nextSampleAt += sampleIntervalMs;
      }
    }
  } finally {
    host.dispose();
  }
  sample(); // final sample

  const end = Date.now();
  const status = {
    runId,
    pid: process.pid,
    startUtc: runInfo.startUtc,
    endUtc: new Date(end).toISOString(),
    wallClockMs: end - ctx.start,
    durationMin: durationMin,
    turns: ctx.turns,
    turnOk: ctx.ok,
    turnFail: ctx.fail,
    iterations: model.callCount,
    clears: ctx.cleared,
    resumeSpawns: ctx.resumeSpawns,
    resumeOk: ctx.resumeOk,
    lastResumeMs: ctx.lastResumeMs ?? null,
    lastResumeParentMs: ctx.lastResumeMs ?? null,
    lastResumeHandshakeMs: ctx.lastResumeHandshakeMs ?? null,
    lastResumeChildMs: ctx.lastResumeChildMs ?? null,
    unreapedResumePid: ctx.unreapedResumePid ?? null,
    lastError: ctx.lastError ?? null,
    finalRssBytes: process.memoryUsage().rss,
    finalActiveChildren: activeChildren(),
    finalActiveResumeChildren: activeResumeChildren(),
    resumeChildrenCreated: childState.resumeCreated,
    resumeChildrenExited: childState.resumeExited,
    completed: ctx.fail === 0 && ctx.resumeOk === ctx.resumeSpawns && end - ctx.start >= durationMin * 60_000 - 5000,
  };
  writeFileSync(statusJsonPath, JSON.stringify(status, null, 2));
  process.stderr.write(
    `[soak] END runId=${runId} wall=${Math.round(status.wallClockMs / 1000)}s turns=${ctx.turns} ok=${ctx.ok} fail=${ctx.fail} ` +
      `resume=${ctx.resumeOk}/${ctx.resumeSpawns} clears=${ctx.cleared} active_children=${activeChildren()} ` +
      `active_resume_children=${activeResumeChildren()} completed=${status.completed}\n`,
  );
  return status.completed ? 0 : 2;
}

const mode = process.argv[2];
const args = parseArgs(process.argv.slice(3));

if (mode === "child" || mode === "run") {
  const validated = validateSoakPaths({ mode, diHome: args["di-home"], out: args.out, workspace: args.workspace, repo: resolve(HERE_DIR, "../../../..") });
  args["di-home"] = validated.diHome;
  args.out = validated.out;
  args.workspace = validated.workspace;
}

if (mode === "child") {
  process.exitCode = await childPhase(args);
} else if (mode === "run") {
  process.exitCode = await runPhase(args);
} else {
  console.error(`usage: soak-runner.mjs <run|child> --di-home <dir> --workspace <dir> ...`);
  process.exitCode = 2;
}
