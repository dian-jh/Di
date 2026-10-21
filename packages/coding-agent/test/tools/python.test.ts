import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { createPythonTool, ProcessDiagnostics } from "@di/coding-agent";

/**
 * P4-shell-session card — the Python tool (port of `Core/Tools/PythonTool.cs` at
 * 09f4e08): executes code via `python -c` in a standalone process whose default
 * working directory is the system temp dir (process-level isolation only — NOT
 * an OS sandbox, no filesystem/network restriction claimed). stdin starts at EOF
 * (redirected then closed), timeout force-kills the tree, output is forced to
 * UTF-8 (PYTHONIOENCODING=utf-8 pinned + UTF-8 decode).
 *
 * Every case is red by ASSERTION: the exports do not exist yet, so this file
 * fails to load (SyntaxError) — that is the red gate for the card.
 */

const base = mkdtempSync(join(tmpdir(), "di-py-"));
test.after(() => rmSync(base, { recursive: true, force: true }));

/** Locate a runnable python; undefined when none exists (C# TestEnvironment.FindPython). */
function findPython(): string | undefined {
  for (const candidate of ["python", "python3"]) {
    const probe = spawnSync(candidate, ["-c", "print('ok')"], { windowsHide: true });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}

const PY = findPython();
const pyOrSkip = (t: test.TestContext): void => {
  if (PY === undefined) {
    t.skip("no usable python on this machine; python cases skipped");
  }
};

function newTool(opts?: { timeoutSeconds?: number }): ReturnType<typeof createPythonTool> {
  assert.ok(PY !== undefined, "python required for tool construction in these tests");
  return createPythonTool(PY, opts);
}

function args(code: string, workingDir?: string): string {
  return workingDir === undefined
    ? `{"code":${JSON.stringify(code)}}`
    : `{"code":${JSON.stringify(code)},"working_dir":${JSON.stringify(workingDir)}}`;
}

// ---- 正常路径 ----

test("① runs code and returns stdout", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const obs = await newTool().execute(args("print(6 * 7)"));
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("42"), obs.text);
});

test("② raised exception returns non-zero exit and the traceback", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const obs = await newTool().execute(args("raise ValueError('boom')"));
  assert.ok(obs.text.startsWith("exit: 1"), obs.text);
  assert.ok(obs.text.includes("Traceback"), obs.text);
  assert.ok(obs.text.includes("boom"), obs.text);
});

test("③ working directory is honored", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  mkdirSync(join(base, "work"), { recursive: true });
  const obs = await newTool().execute(args("import os; print(os.getcwd())", join(base, "work")));
  assert.ok(obs.text.includes("work"), obs.text);
});

test("④ default working directory is the temp sandbox", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const obs = await newTool().execute(args("import os; print(os.getcwd())"));
  assert.ok(obs.text.toLowerCase().includes(tmpdir().toLowerCase()), obs.text);
});

test("⑤ multiline code runs correctly", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const obs = await newTool().execute(args("x = 0\nfor i in range(5):\n    x += i\nprint(x)"));
  assert.ok(obs.text.includes("10"), obs.text);
});

test("⑥ code containing quotes runs", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const obs = await newTool().execute(args('print(\'it\\\'s\', "a\\"b\\"")'));
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("it's"), obs.text);
  assert.ok(obs.text.includes('a"b"'), obs.text);
});

test("⑦ Chinese print output round-trips", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const obs = await newTool().execute(args("print('你好世界')"));
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("你好世界"), obs.text);
});

test("⑧ code writing a file in its working dir works", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const obs = await newTool().execute(
    args("with open('made.py', 'w') as f: f.write('ok')\nprint('written')"),
  );
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("written"), obs.text);
});

test("⑨ unicode computation works", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const obs = await newTool().execute(args("print(len('héllo wörld'))"));
  assert.ok(obs.text.includes("11"), obs.text);
});

test("⑩ sys.exit reports the exit code", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const obs = await newTool().execute(args("import sys; sys.exit(7)"));
  assert.ok(obs.text.startsWith("exit: 7"), obs.text);
});

// ---- 沙盒约束 ----

test("⑪ stdin starts at EOF (redirected then closed, not inherited)", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const obs = await newTool().execute(
    args("import sys\nprint('isatty', sys.stdin.isatty())\nprint('eof', sys.stdin.read(1) == '')"),
  );
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("isatty False"), obs.text);
  assert.ok(obs.text.includes("eof True"), obs.text);
});

// ---- 失败路径 ----

test("⑫ timeout returns a structured error", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const obs = await newTool({ timeoutSeconds: 0.3 }).execute(args("import time; time.sleep(60)"));
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("秒"), obs.text);
});

test("⑬ timeout emits process diagnostics (proc: start / proc: timeout)", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const lines: string[] = [];
  const previous = ProcessDiagnostics.log;
  ProcessDiagnostics.log = (msg) => lines.push(msg);
  try {
    const obs = await newTool({ timeoutSeconds: 0.3 }).execute(args("import time; time.sleep(60)"));
    assert.ok(obs.text.startsWith("error:"), obs.text);
    assert.ok(lines.some((l) => l.startsWith("proc: start")), `proc: start seen, got: ${lines.join(" | ")}`);
    assert.ok(lines.some((l) => l.startsWith("proc: timeout")), `proc: timeout seen, got: ${lines.join(" | ")}`);
  } finally {
    ProcessDiagnostics.log = previous;
  }
});

test("⑭ missing code argument returns an error mentioning code", async () => {
  const obs = await createPythonTool().execute("{}");
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("code"), obs.text);
});

test("⑮ nonexistent working directory returns an error", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const obs = await newTool().execute(args("print(1)", "no/such/dir"));
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("目录不存在"), obs.text);
});

test("⑯ working_dir containing NUL returns an error, never throws", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const obs = await newTool().execute(args("print(1)", "bad\u0000dir"));
  assert.ok(obs.text.startsWith("error:"), obs.text);
});

test("⑰ invalid JSON returns an error observation", async () => {
  const obs = await createPythonTool().execute("nope");
  assert.ok(obs.text.startsWith("error:"), obs.text);
});

test("⑱ missing python executable returns 无法启动", async () => {
  const tool = createPythonTool("definitely_not_a_real_python_xyz");
  const obs = await tool.execute(args("print(1)"));
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("无法启动"), obs.text);
});

test("⑲ external cancel propagates AbortError, not an error observation", async (t) => {
  pyOrSkip(t);
  if (PY === undefined) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 150);
  try {
    await assert.rejects(
      newTool().execute(args("import time; time.sleep(60)"), ac.signal),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  } finally {
    clearTimeout(timer);
  }
});

test("⑳ definition has name python and a code property", () => {
  const spec = createPythonTool().spec;
  assert.equal(spec.name, "python");
  const properties = spec.parameters.properties as Record<string, { type?: string }>;
  assert.ok(properties.code !== undefined, "properties.code present");
  assert.ok(properties.working_dir !== undefined, "properties.working_dir present");
});
