import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import { DiLog, EventBus, LogLevel, ProcessDiagnostics } from "@di/coding-agent";
import type { DiLogOptions, ProcessDiagnosticSink } from "@di/coding-agent";

/**
 *
 * (`[yyyy-MM-dd HH:mm:ss.fff] [LEVEL] message`), one daily
 * `di-YYYY-MM-DD.log` (LOCAL-time naming, rotation by injected clock), the
 * turn lifecycle timeline (run:started / llm:call_started / llm:call_completed
 * with duration/usage/finish, run_failed, tool lines), verbatim stream deltas
 * skipped, field fold/truncation, sensitive-field redaction, dispose exit
 * flush (idempotent), log I/O failure silently dropped (independent of the
 * checkpoint fail-closed path), and the ProcessDiagnostics static hook
 * (default no-op, injected lines flow to DiLog).
 */

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "di-log-"));
}

function cleanUp(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function options(root: string): DiLogOptions {
  return { rootDirectory: root };
}

function logFile(root: string, date: string): string {
  return join(root, "logs", `di-${date}.log`);
}

/** Read a log file even while DiLog still holds the write handle (readFileSync shares the file). */
function readLines(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return text.length === 0 ? [] : text.split(/\r?\n/).filter((line) => line.length > 0);
}

/** Local-time `yyyy-MM-dd` key, mirroring the rotation key / filename date. */
function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Line at index (non-null assertion — the project enables noUncheckedIndexedAccess). */
function lineAt(lines: string[], index: number): string {
  const value = lines[index];
  assert.ok(value !== undefined, `expected a log line at index ${index}`);
  return value;
}

// ---- 基础格式与落盘位置 ----

test("Log_WritesJcodeFormatLine", () => {
  const root = makeRoot();
  const log = new DiLog(options(root));
  log.log(LogLevel.Info, "di starting");
  log.dispose();

  const lines = readLines(logFile(root, dateKey(new Date())));
  assert.match(lineAt(lines, 0), /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[INFO\] di starting$/);
  cleanUp(root);
});

test("Log_WritesToDiLogsDateFile", () => {
  const root = makeRoot();
  const log = new DiLog(options(root));
  log.log(LogLevel.Info, "hi");
  log.dispose();

  const file = logFile(root, dateKey(new Date()));
  assert.equal(existsSync(file), true);
  assert.equal(basename(file), `di-${dateKey(new Date())}.log`);
  cleanUp(root);
});

test("Log_RotatesFileWhenDateChanges", () => {
  const root = makeRoot();
  let now = new Date(2026, 9, 14, 11, 35, 59); // local 2026-10-14 11:35:59
  const log = new DiLog({ rootDirectory: root, clock: () => now });

  log.log(LogLevel.Info, "day one");
  now = new Date(now.getTime() + 24 * 60 * 60 * 1000); // next local day
  log.log(LogLevel.Info, "day two");

  // NB: dispose appends "di exiting" to the CURRENT day's file — read before dispose.
  const lines14 = readLines(logFile(root, "2026-10-14"));
  assert.equal(lines14.length, 1);
  assert.ok(lineAt(lines14, 0).endsWith("day one"));
  const lines15 = readLines(logFile(root, "2026-10-15"));
  assert.equal(lines15.length, 1);
  assert.ok(lineAt(lines15, 0).endsWith("day two"));
  log.dispose();
  cleanUp(root);
});

// ---- 事件 → 日志行（完整时间线 / 失败 / 工具 / 流增量跳过） ----

test("UserInputToModelResponse_WritesCompleteTimeline", () => {
  const root = makeRoot();
  const bus = new EventBus();
  const log = new DiLog(options(root));
  log.subscribe(bus);

  bus.publish({ type: "runStarted", userMessage: "你好" });
  bus.publish({ type: "modelCallStarted", iteration: 1 });
  bus.publish({
    type: "turnCompleted",
    iteration: 1,
    usage: { inputTokens: 120, outputTokens: 85, cacheReadTokens: 900 },
    cost: { input: 1.0, output: 0.5, cacheRead: 0.25, cacheWrite: 0 },
    finishReason: { type: "stop" },
  });

  const lines = readLines(logFile(root, dateKey(new Date())));
  log.dispose();
  assert.equal(lines.length, 3);
  assert.ok(lineAt(lines, 0).includes("[INFO]"));
  assert.ok(lineAt(lines, 0).includes("run: started"));
  assert.ok(lineAt(lines, 0).includes("你好"));
  assert.ok(lineAt(lines, 1).includes("llm: call_started iteration=1"));
  assert.ok(lineAt(lines, 2).includes("llm: call_completed iteration=1"));
  assert.ok(lineAt(lines, 2).includes("duration_ms="));
  assert.ok(lineAt(lines, 2).includes("tokens_in=120"));
  assert.ok(lineAt(lines, 2).includes("tokens_out=85"));
  assert.ok(lineAt(lines, 2).includes("cache_read=900"));
  assert.ok(lineAt(lines, 2).includes("finish=stop"));
  cleanUp(root);
});

test("RunFailed_WritesErrorLineWithDuration", () => {
  const root = makeRoot();
  const bus = new EventBus();
  const log = new DiLog(options(root));
  log.subscribe(bus);

  bus.publish({ type: "modelCallStarted", iteration: 1 });
  bus.publish({ type: "runFailed", failure: { code: "MissingCredential", message: "no api key" } });

  const lines = readLines(logFile(root, dateKey(new Date())));
  log.dispose();
  assert.equal(lines.length, 2);
  assert.ok(lineAt(lines, 1).includes("[ERROR]"));
  assert.ok(lineAt(lines, 1).includes("llm: run_failed"));
  assert.ok(lineAt(lines, 1).includes("code="));
  assert.ok(lineAt(lines, 1).includes("error=no api key"));
  assert.ok(lineAt(lines, 1).includes("duration_ms="));
  cleanUp(root);
});

test("ToolStartedCompleted_WritesInfoAndWarnLines", () => {
  const root = makeRoot();
  const bus = new EventBus();
  const log = new DiLog(options(root));
  log.subscribe(bus);

  const call = { type: "tool-call" as const, id: "c1", name: "bash", arguments: '{"command":"dir"}' };
  bus.publish({ type: "toolStarted", call });
  bus.publish({ type: "toolCompleted", call, observation: "目录内容", isError: false });
  bus.publish({ type: "toolCompleted", call, observation: "error executing tool: boom", isError: true });

  const lines = readLines(logFile(root, dateKey(new Date())));
  log.dispose();
  assert.equal(lines.length, 3);
  assert.ok(lineAt(lines, 0).includes("tool: started name=bash"));
  assert.ok(lineAt(lines, 1).includes("[INFO]"));
  assert.ok(lineAt(lines, 1).includes("tool: completed name=bash"));
  assert.ok(lineAt(lines, 2).includes("[WARN]"));
  assert.ok(lineAt(lines, 2).includes("tool: failed name=bash"));
  assert.ok(lineAt(lines, 2).includes("error=error executing tool: boom"));
  cleanUp(root);
});

test("StreamDeltaEvents_AreSkipped", () => {
  const root = makeRoot();
  const bus = new EventBus();
  const log = new DiLog(options(root));
  log.subscribe(bus);

  // Verbatim stream increments are noise (the full text lives in sessions/*.jsonl), never logged.
  bus.publish({ type: "textDelta", delta: "你" });
  bus.publish({ type: "reasoningDelta", delta: "思" });
  bus.publish({ type: "toolCallDelta", id: "c1", name: "bash", arguments: "{}" });
  bus.publish({ type: "modelCallStarted", iteration: 1 });
  bus.publish({
    type: "turnCompleted",
    iteration: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    finishReason: { type: "stop" },
  });

  const lines = readLines(logFile(root, dateKey(new Date())));
  log.dispose();
  assert.equal(lines.length, 2); // only call_started + call_completed
  cleanUp(root);
});

// ---- 折叠 / 截断 / 敏感字段 ----

test("LongMultiLineFields_AreFoldedAndTruncated", () => {
  const root = makeRoot();
  const bus = new EventBus();
  const log = new DiLog(options(root));
  log.subscribe(bus);

  const input = "line1\n\n  line2   line3" + "y".repeat(350);
  bus.publish({ type: "runStarted", userMessage: input });

  const lines = readLines(logFile(root, dateKey(new Date())));
  log.dispose();
  assert.equal(lines.length, 1);
  const line = lineAt(lines, 0);
  assert.ok(!line.includes("\n"), "log line must never wrap");
  assert.ok(line.includes("run: started user_input=line1 line2 line3"), "runs of whitespace folded");
  assert.ok(line.endsWith("…"), "over-length field truncated with …");
  assert.ok(line.length <= 400, "single field capped at 300 chars plus the line prefix");
  cleanUp(root);
});

test("SensitiveFields_NeverAppearInTheLog", () => {
  const root = makeRoot();
  const bus = new EventBus();
  const log = new DiLog(options(root));
  log.subscribe(bus);

  const secret = "sk-secret-token-value-123456";
  bus.publish({ type: "runStarted", userMessage: `please check Authorization: Bearer ${secret}` });
  bus.publish({ type: "modelCallStarted", iteration: 1 });
  bus.publish({
    type: "runFailed",
    failure: { code: "Auth", message: `got 401: token=${secret} Cookie: yummy` },
  });

  const lines = readLines(logFile(root, dateKey(new Date())));
  log.dispose();
  const all = lines.join("\n");
  assert.ok(!all.includes(secret), `log must never contain the secret value; got:\n${all}`);
  assert.ok(!all.includes(`Bearer ${secret}`));
  assert.ok(lineAt(lines, 0).includes("run: started user_input=please check Authorization:***"), lines[0]);
  cleanUp(root);
});

// ---- 退出 flush / 幂等 / I/O 失败静默兜底 ----

test("UnwritableLogDirectory_DoesNotThrow", () => {
  const root = makeRoot();
  const blocker = join(root, "blocker");
  writeFileSync(blocker, "占用该路径"); // {root}/logs becomes a path under a file → create must fail

  const log = new DiLog({ rootDirectory: blocker });
  log.log(LogLevel.Info, "hi"); // silent drop, never throws
  log.dispose();
  cleanUp(root);
});

test("Dispose_WritesExitingLine", () => {
  const root = makeRoot();
  const log = new DiLog(options(root));
  log.log(LogLevel.Info, "work");
  log.dispose();

  const lines = readLines(logFile(root, dateKey(new Date())));
  assert.equal(lines.length, 2);
  assert.ok(lineAt(lines, 0).endsWith("work"));
  assert.ok(lineAt(lines, 1).endsWith("di exiting"));
  cleanUp(root);
});

test("Dispose_IsIdempotent", () => {
  const root = makeRoot();
  const log = new DiLog(options(root));
  log.log(LogLevel.Info, "work");
  log.dispose();
  log.dispose(); // second dispose: no throw, no duplicate exiting line

  const lines = readLines(logFile(root, dateKey(new Date())));
  assert.equal(lines.length, 2);
  cleanUp(root);
});

// ---- ProcessDiagnostics 静态钩子（默认 no-op，注入后流向 DiLog） ----

test("ProcessDiagnostics_DefaultNoOp_WritesNothingAndDoesNotThrow", () => {
  const root = makeRoot();
  const log = new DiLog(options(root));
  log.log(LogLevel.Info, "only this");

  // Default is a no-op: a guarded call-site must not throw and must write nothing.
  const defaultHook: ProcessDiagnosticSink | null = ProcessDiagnostics.log;
  defaultHook?.("proc: start name=python exe=C:\\python.exe pid=123 timeout_s=30"); // guarded call
  assert.equal(defaultHook, null, "default hook is a no-op");

  log.dispose();
  const lines = readLines(logFile(root, dateKey(new Date())));
  assert.equal(lines.length, 2); // only "only this" + "di exiting"
  cleanUp(root);
});

test("ProcessDiagnostics_InjectedSink_FlowsProcLinesToTheLog", () => {
  const root = makeRoot();
  const log = new DiLog(options(root));
  try {
    ProcessDiagnostics.log = (msg) => log.log(LogLevel.Info, msg); // host wiring
    ProcessDiagnostics.log("proc: start name=python exe=C:\\python.exe pid=123 timeout_s=30 cwd=C:\\work");
    ProcessDiagnostics.log("proc: running name=python pid=123 elapsed_ms=5000 cpu_ms=240");
    ProcessDiagnostics.log("proc: timeout name=python pid=123 elapsed_ms=30000 cpu_ms=12");
    ProcessDiagnostics.log("proc: exited name=python pid=123 exit=0 elapsed_ms=2500 cpu_ms=240");

    log.dispose();
    const lines = readLines(logFile(root, dateKey(new Date())));
    assert.equal(lines.length, 5); // 4 proc lines + di exiting
    assert.ok(lineAt(lines, 0).includes("proc: start name=python"));
    assert.ok(lineAt(lines, 1).includes("proc: running name=python pid=123 elapsed_ms=5000"));
    assert.ok(lineAt(lines, 2).includes("proc: timeout name=python pid=123 elapsed_ms=30000"));
    assert.ok(lineAt(lines, 3).includes("proc: exited name=python pid=123 exit=0"));
  } finally {
    ProcessDiagnostics.log = null;
    cleanUp(root);
  }
});
