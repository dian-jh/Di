import test from "node:test";
import assert from "node:assert/strict";
import { ProcessDiagnostics, runProcess } from "@di/coding-agent";

/**
 *
 * produces bypass `proc: start / start_failed / running / timeout / exited`
 * diagnostic lines through the static hook. Default hook is null (no-op); the
 * host (composition root) wires it to `DiLog.log`.
 *
 * equivalent, so the lines carry elapsed_ms / exit / timeout_s / cwd / cmd but
 * NO `cpu_ms` field.
 */

const node = process.execPath;

test("process diagnostics: proc: start + exited lines via the static hook", async () => {
  const lines: string[] = [];
  ProcessDiagnostics.log = (msg) => lines.push(msg);
  try {
    const result = await runProcess(node, ["-v"], { diagnostics: { exitedMinElapsedMs: 0 } });
    assert.equal(result.exitCode, 0);

    const start = lines.find((l) => l.startsWith("proc: start "));
    assert.ok(start !== undefined, "a proc: start line is emitted");
    assert.ok(start!.includes("pid="), "the start line carries the child pid");
    assert.ok(start!.includes("name="), "the start line carries the program name");
    assert.ok(start!.includes("cwd="), "the start line carries the working directory");
    assert.ok(start!.includes("cmd=<<"), "the start line carries the command line");

    const exited = lines.find((l) => l.startsWith("proc: exited "));
    assert.ok(exited !== undefined, "a proc: exited line is emitted");
    assert.ok(exited!.includes("exit=0"), "the exited line carries the exit code");
    assert.ok(exited!.includes("elapsed_ms="), "the exited line carries the elapsed time");
  } finally {
    ProcessDiagnostics.log = null;
  }
});

test("process diagnostics: proc: start_failed line when the binary cannot start", async () => {
  const lines: string[] = [];
  ProcessDiagnostics.log = (msg) => lines.push(msg);
  try {
    const result = await runProcess("definitely-not-a-real-binary-xyz", []);
    assert.ok(result.error !== null, "startup failure is an error observation");

    const failed = lines.find((l) => l.startsWith("proc: start_failed "));
    assert.ok(failed !== undefined, "a proc: start_failed line is emitted");
  } finally {
    ProcessDiagnostics.log = null;
  }
});

test("process diagnostics: proc: timeout line when a process exceeds the timeout", async () => {
  const lines: string[] = [];
  ProcessDiagnostics.log = (msg) => lines.push(msg);
  try {
    const result = await runProcess(node, ["-e", "setTimeout(() => {}, 100000)"], {
      timeoutMs: 500,
      diagnostics: { exitedMinElapsedMs: 0 },
    });
    assert.ok(result.error !== null, "timeout is an error observation");

    const timeout = lines.find((l) => l.startsWith("proc: timeout "));
    assert.ok(timeout !== undefined, "a proc: timeout line is emitted");
    assert.ok(timeout!.includes("elapsed_ms="), "the timeout line carries the elapsed time");
    assert.ok(timeout!.includes("partial=<<"), "the timeout line carries the partial output");
  } finally {
    ProcessDiagnostics.log = null;
  }
});

test("process diagnostics: heartbeat emits proc: running lines for a long-running process", async () => {
  const lines: string[] = [];
  ProcessDiagnostics.log = (msg) => lines.push(msg);
  try {
    // A bounded timeout (>= heartbeatMinTimeoutMs) starts the heartbeat monitor;
    // the process outlives several ticks so proc: running lines are emitted.
    const result = await runProcess(node, ["-e", "setTimeout(() => process.exit(0), 700)"], {
      timeoutMs: 5000,
      diagnostics: { heartbeatTickMs: 50, heartbeatIntervalMs: 100, heartbeatMinTimeoutMs: 0, exitedMinElapsedMs: 0 },
    });
    assert.equal(result.exitCode, 0);

    const running = lines.filter((l) => l.startsWith("proc: running "));
    assert.ok(running.length >= 1, "at least one proc: running line is emitted while the process runs");
    assert.ok(running[0]!.includes("elapsed_ms="), "the running line carries the elapsed time");
  } finally {
    ProcessDiagnostics.log = null;
  }
});

test("process diagnostics: the hook is a no-op by default (no throws, no lines)", async () => {
  ProcessDiagnostics.log = null;
  const result = await runProcess(node, ["-v"], { diagnostics: { exitedMinElapsedMs: 0 } });
  assert.equal(result.exitCode, 0, "the runner works with no hook wired");
});
