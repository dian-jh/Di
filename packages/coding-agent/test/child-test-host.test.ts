import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runProcess } from "@di/coding-agent";

/**
 * P5 process-boundary crash/resume acceptance: an INDEPENDENT child test host —
 * a real Node process importing the committed @di/coding-agent dist — drives a
 * REAL session store in an isolated temp DI_HOME, executes a tool with a durable
 * side effect, is force-killed (process-tree kill via runProcess), then is
 * relaunched against the SAME session file. The gate:
 *
 * - the completed tool RESULT is preserved across the kill (recovery returns it),
 * - the host does NOT replay side effects (the side-effect log stays at 1 line),
 * - a started-but-unfinished tool outcome rejects recovery (fail closed) and is
 *   never replayed.
 *
 * No real credentials, no real network, isolated temp DI_HOME only.
 */

const node = process.execPath;
const hostPath = fileURLToPath(new URL("./child-test-host/host.mjs", import.meta.url));
const cwd = process.cwd();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path: string, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitGone(pid: number, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH: the killed process is gone.
    }
    await delay(50);
  }
  throw new Error(`process ${pid} is still alive after the tree kill`);
}

interface Phase2Outcome {
  recoveredRoles: string[];
  c1Result: string | null;
  c2Note: string | null;
  sideEffectCount: number;
  replayDetected: boolean;
  rejected?: boolean;
  code?: string | null;
}

test("P5 child test host: force-killed host resumes preserving results without replaying side effects", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-child-host-"));
  try {
    // ---- phase 1: a real store, a real side effect, checkpointed result, park ----
    const abort1 = new AbortController();
    const phase1Promise = runProcess(node, [hostPath, "run", diHome, "after-completed"], {
      cwd,
      signal: abort1.signal,
    });
    await waitForFile(join(diHome, "phase1-ready.json"), 20_000);
    const ready = JSON.parse(readFileSync(join(diHome, "phase1-ready.json"), "utf8")) as { pid: number };
    const sideEffectsPath = join(diHome, "side-effects.log");
    const sideEffectCountPhase1 = readFileSync(sideEffectsPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    assert.equal(sideEffectCountPhase1, 1, "phase 1 must execute the tool exactly once");

    // ---- kill the child: process-tree kill (taskkill /T /F on Windows) ----
    abort1.abort();
    await assert.rejects(phase1Promise, (error: unknown) => (error as Error).name === "AbortError");
    await waitGone(ready.pid, 15_000); // which process was killed: ready.pid, now ESRCH.

    // ---- phase 2: relaunch against the SAME session file; results preserved, no replay ----
    const phase2 = await runProcess(node, [hostPath, "resume", diHome], { cwd });
    assert.equal(phase2.exitCode, 0, `resume host must exit 0: ${phase2.output}`);
    const outcome = JSON.parse(readFileSync(join(diHome, "phase2-done.json"), "utf8")) as Phase2Outcome;
    assert.equal(outcome.sideEffectCount, 1, "no side-effect replay across the kill/restart");
    assert.equal(outcome.replayDetected, false, JSON.stringify(outcome));
    assert.equal(outcome.c1Result, "deployed ok", "the completed result must be preserved");
    assert.ok(outcome.c2Note !== null && outcome.c2Note.includes("not executed"), "never-started c2 becomes the explicit note");
    assert.ok(outcome.recoveredRoles.includes("tool"), "the recovered trajectory carries the tool result");
  } finally {
    rmSync(diHome, { recursive: true, force: true });
  }
});

test("P5 child test host: a started-but-unfinished tool rejects recovery and is never replayed", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-child-host-"));
  try {
    // ---- phase 1: tool started + real side effect, then killed BEFORE the completed record ----
    const abort1 = new AbortController();
    const phase1Promise = runProcess(node, [hostPath, "run", diHome, "after-started"], {
      cwd,
      signal: abort1.signal,
    });
    await waitForFile(join(diHome, "phase1-ready.json"), 20_000);
    const ready = JSON.parse(readFileSync(join(diHome, "phase1-ready.json"), "utf8")) as { pid: number };
    abort1.abort();
    await assert.rejects(phase1Promise, (error: unknown) => (error as Error).name === "AbortError");
    await waitGone(ready.pid, 15_000);

    // ---- phase 2: recovery must FAIL CLOSED (unknown outcome), and the side effect must not be replayed ----
    const phase2 = await runProcess(node, [hostPath, "resume-unknown", diHome], { cwd });
    assert.equal(phase2.exitCode, 0, `resume-unknown host must exit 0: ${phase2.output}`);
    const outcome = JSON.parse(readFileSync(join(diHome, "phase2-done.json"), "utf8")) as Phase2Outcome;
    assert.equal(outcome.rejected, true, "started-without-result must reject recovery");
    assert.ok(outcome.code !== null && String(outcome.code).includes("unknown"), `code=${String(outcome.code)}`);
    assert.equal(outcome.sideEffectCount, 1, "the unknown-outcome tool must never be replayed");
    assert.equal(outcome.replayDetected, false);
  } finally {
    rmSync(diHome, { recursive: true, force: true });
  }
});
