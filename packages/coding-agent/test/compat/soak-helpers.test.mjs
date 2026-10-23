import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn as spawnProcess } from "node:child_process";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runResumeChild } from "../soak/resume-child.mjs";
import { makeCheckpointTracker } from "../soak/checkpoint-tracker.mjs";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode = null;
  killed = false;
  killCalls = [];

  kill(signal) {
    this.killed = true;
    this.killCalls.push(signal);
    return true;
  }

  finish(code = 0, signal = null) {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

test("resume success waits for close after the RESUMED handshake", async () => {
  const child = new FakeChild();
  const state = { created: 0, exited: 0, resumeCreated: 0, resumeExited: 0 };
  let settled = false;
  const pending = runResumeChild({
    spawn: () => child,
    childState: state,
    timeoutMs: 100,
    killGraceMs: 20,
  }).then((result) => {
    settled = true;
    return result;
  });

  child.emit("spawn");
  child.stdout.write("RESUMED 17\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(state, { created: 1, exited: 0, resumeCreated: 1, resumeExited: 0 });

  child.finish(0);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.childMs, 17);
  assert.equal(result.closed, true);
  assert.equal(state.created - state.exited, 0);
  assert.equal(state.resumeCreated - state.resumeExited, 0);
});

test("real resume child is not complete until Node emits close", async () => {
  const child = spawnProcess(process.execPath, [
    "-e",
    'console.log("RESUMED 23"); setTimeout(() => process.exit(0), 30);',
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let sawClose = false;
  child.once("close", () => { sawClose = true; });
  const result = await runResumeChild({
    spawn: () => child,
    childState: { created: 0, exited: 0, resumeCreated: 0, resumeExited: 0 },
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.childMs, 23);
  assert.equal(result.closed, true);
  assert.equal(sawClose, true);
});

test("resume timeout kills, escalates, and returns a bounded unreaped failure", async () => {
  const child = new FakeChild();
  const state = { created: 0, exited: 0, resumeCreated: 0, resumeExited: 0 };
  const pending = runResumeChild({
    spawn: () => child,
    childState: state,
    timeoutMs: 5,
    killGraceMs: 5,
  });
  child.emit("spawn");
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.closed, false);
  assert.deepEqual(child.killCalls, [undefined, "SIGKILL"]);
  assert.equal(state.created - state.exited, 1);

  child.finish(1);
  assert.equal(state.created - state.exited, 0);
});

test("resume handshake with nonzero exit is a failure and is reaped", async () => {
  const child = new FakeChild();
  const state = { created: 0, exited: 0, resumeCreated: 0, resumeExited: 0 };
  const pending = runResumeChild({ spawn: () => child, childState: state, timeoutMs: 100 });
  child.emit("spawn");
  child.stdout.write("RESUMED 9\n");
  child.finish(2);

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.childMs, 9);
  assert.equal(result.exitCode, 2);
  assert.equal(state.created, state.exited);
});

test("synchronous and asynchronous spawn failures do not corrupt child counts", async () => {
  const state = { created: 0, exited: 0, resumeCreated: 0, resumeExited: 0 };
  const thrown = await runResumeChild({ spawn: () => { throw new Error("spawn failed"); }, childState: state });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.spawned, false);
  assert.deepEqual(state, { created: 0, exited: 0, resumeCreated: 0, resumeExited: 0 });

  const child = new FakeChild();
  const pending = runResumeChild({ spawn: () => child, childState: state, timeoutMs: 100, killGraceMs: 20 });
  child.emit("error", new Error("ENOENT"));
  child.finish(-2);
  const failed = await pending;
  assert.equal(failed.ok, false);
  assert.equal(state.created, 0);
  assert.equal(state.exited, 0);
});

test("checkpoint tracker handles growth, UTF-8 byte boundaries, and truncation with bounded allocation", () => {
  const directory = mkdtempSync(join(tmpdir(), "di-checkpoint-tracker-"));
  const path = join(directory, "session.jsonl");
  const allocationSizes = [];
  const tracker = makeCheckpointTracker({
    bufferSize: 4,
    allocate: (size) => {
      allocationSizes.push(size);
      return Buffer.allocUnsafe(size);
    },
  });
  try {
    writeFileSync(path, "α\nβ", "utf8");
    assert.deepEqual(tracker(path), { bytes: Buffer.byteLength("α\nβ"), lines: 1 });
    writeFileSync(path, "\n猫\n", { encoding: "utf8", flag: "a" });
    assert.deepEqual(tracker(path), { bytes: Buffer.byteLength("α\nβ\n猫\n"), lines: 3 });

    truncateSync(path, 0);
    writeFileSync(path, "x\ny", "utf8");
    assert.deepEqual(tracker(path), { bytes: 3, lines: 1 });
    writeFileSync(path, "\nz", { encoding: "utf8", flag: "a" });
    assert.deepEqual(tracker(path), { bytes: 5, lines: 2 });
    assert.ok(allocationSizes.every((size) => size === 4));
    assert.equal(allocationSizes.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
