import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OUTPUT_MAX_BYTES, runProcess } from "@di/coding-agent";

/**
 *
 * stdout + stderr drained in parallel into one bounded byte ring (head 6000 /
 * tail 18000 with a truncation notice), non-zero exit code is observation text
 * (never a throw), timeout returns `error:` + bounded partial, external abort
 * propagates AbortError, cancel/timeout kills the whole process tree with no
 * survivors (Windows taskkill /PID /T /F), failed startup becomes observation
 * text, and every call cleans up its listeners/timers/streams.
 *
 * Every business case is red by ASSERTION (never a path / missing-export error):
 * the scaffold resolves an empty success result, so the exit-text, bounded-drain,
 * timeout, abort-rejection and startup-failure assertions all fail.
 */

const node = process.execPath;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a pid file until it parses as "parentPid,grandchildPid"; null on timeout. */
async function readPids(pidFile: string, budgetMs: number): Promise<number[] | null> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const parts = readFileSync(pidFile, "utf8")
        .trim()
        .split(",")
        .map((s) => Number.parseInt(s, 10));
      if (parts.length === 2 && parts.every((n) => Number.isInteger(n) && n > 0)) {
        return parts;
      }
    } catch {
      // pid file not written yet
    }
    await delay(50);
  }
  return null;
}

test("returns exit code and merged output in the observation", async () => {
  const result = await runProcess(node, ["-e", "console.log('hello')"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, null);
  assert.ok(result.output.includes("hello"), result.output);
  assert.equal(result.toObservation(), "exit: 0\nhello");
});

test("non-zero exit code is observation text, not a throw", async () => {
  const result = await runProcess(node, ["-e", "process.exit(3)"]);
  assert.equal(result.exitCode, 3);
  assert.equal(result.error, null);
  assert.ok(result.toObservation().startsWith("exit: 3"), result.toObservation());
});

test("stdout and stderr drain in parallel into one bounded output", async () => {
  // writeSync flushes synchronously; 30k 'O' + 30k 'E' far exceed the 24k budget.
  const code =
    "const fs=require('fs');" +
    "fs.writeSync(1, Buffer.alloc(30000, 79));" +
    "fs.writeSync(2, Buffer.alloc(30000, 69));";
  const result = await runProcess(node, ["-e", code]);

  assert.ok(result.output.includes("O"), `stdout captured (len=${result.output.length})`);
  assert.ok(result.output.includes("E"), `stderr captured (len=${result.output.length})`);
  assert.ok(result.output.includes("已截断"), "over-budget output carries the notice");
  assert.ok(
    result.output.length <= OUTPUT_MAX_BYTES + 200,
    `combined output bounded: ${result.output.length}`,
  );
});

test("huge stdout is truncated to head and tail with a notice", async () => {
  const result = await runProcess(node, ["-e", "process.stdout.write('x'.repeat(40000))"]);
  const text = result.toObservation();
  assert.ok(text.includes("已截断"), text);
  assert.ok(text.startsWith("exit: 0"), text);
  assert.ok(text.length <= OUTPUT_MAX_BYTES + 300, `bounded: ${text.length}`);
});

test("timeout returns an error observation with bounded partial output", async () => {
  const result = await runProcess(node, ["-e", "console.log('partial'); setTimeout(()=>{}, 30000)"], {
    timeoutMs: 300,
  });
  assert.ok(result.error !== null, "timeout must set an error");
  assert.ok(result.output.includes("partial"), `partial output kept: ${result.output}`);
  assert.ok(result.toObservation().startsWith("error:"), result.toObservation());
  assert.ok(result.toObservation().includes("未完成"), result.toObservation());
});

test("external abort propagates AbortError", async () => {
  const controller = new AbortController();
  const run = runProcess(node, ["-e", "setTimeout(()=>{}, 30000)"], {
    signal: controller.signal,
  });
  await delay(200);
  controller.abort();
  await assert.rejects(
    run,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("cancel kills the whole process tree with no survivors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "di-proc-tree-"));
  const pidFile = join(dir, "pids.txt");
  const helper = join(dir, "helper.mjs");
  writeFileSync(
    helper,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      "const pidFile = process.argv[2];",
      'const grandchild = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], { stdio: "ignore" });',
      'writeFileSync(pidFile, `${process.pid},${grandchild.pid}`, "utf8");',
      "setInterval(()=>{}, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  try {
    const controller = new AbortController();
    const run = runProcess(node, [helper, pidFile], { signal: controller.signal });
    await delay(700);
    controller.abort();
    await assert.rejects(
      run,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );

    const pids = await readPids(pidFile, 5000);
    assert.ok(pids !== null, "helper must record its pids before cancel");
    for (const pid of pids) {
      // ESRCH from process.kill(pid, 0) means the process no longer exists.
      assert.throws(
        () => process.kill(pid, 0),
        (error: unknown) =>
          error instanceof Error && (error as NodeJS.ErrnoException).code === "ESRCH",
        `pid ${pid} must not survive`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed startup becomes observation text, not a throw", async () => {
  const missing = join(tmpdir(), "di-no-such-binary-xyz.exe");
  const result = await runProcess(missing, []);
  assert.ok(result.error !== null, "startup failure must set an error");
  assert.ok(result.toObservation().startsWith("error:"), result.toObservation());
  assert.ok(result.toObservation().includes("无法启动进程"), result.toObservation());
});

test("cwd and env options are honored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "di-proc-cwd-"));
  try {
    const result = await runProcess(
      node,
      ["-e", "console.log(process.cwd()); console.log(process.env.DI_PROC_TEST_ENV)"],
      { cwd: dir, env: { DI_PROC_TEST_ENV: "magic" } },
    );
    assert.ok(result.output.includes(dir), result.output);
    assert.ok(result.output.includes("magic"), result.output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no listener/timer/stream accumulation across many calls", async () => {
  const types = new Set(["Timeout", "ChildProcess", "Pipe", "ReadStream", "WriteStream"]);
  const count = (): number => process.getActiveResourcesInfo().filter((r) => types.has(r)).length;

  await runProcess(node, ["-e", ""]); // warm-up
  const before = count();
  for (let i = 0; i < 8; i += 1) {
    await runProcess(node, ["-e", "console.log('x')"], { timeoutMs: 5000 });
  }
  await delay(100);
  const after = count();

  assert.ok(
    after <= before + 2,
    `resources grew across calls: ${before} -> ${after} (${process.getActiveResourcesInfo().join(",")})`,
  );
});
