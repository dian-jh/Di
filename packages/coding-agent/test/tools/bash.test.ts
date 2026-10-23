import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBashTool, createToolExecutor, OUTPUT_MAX_BYTES } from "@di/coding-agent";

/**
 *
 * card and are intentionally absent): output capture, exit codes, stderr merge,
 * timeout termination (default + per-call override), working directory, bad
 * shell, argument/JSON errors and long-output truncation — plus the pessimistic
 * cmd quoting/`&`/redirection/`%CD%` cases and the executor "bash" alias on
 * Windows.
 *
 * Platform-aware commands: the acceptance platform is Windows (cmd), so the
 * Windows branches run here; the POSIX branches (`sleep` / `cat` / `head`) are
 * written but skipped on this machine.
 */

const base = mkdtempSync(join(tmpdir(), "di-bash-"));
test.after(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

const IS_WINDOWS = process.platform === "win32";
const PLATFORM_SHELL_NAME = IS_WINDOWS ? "cmd" : "bash";

/** Cross-platform deterministic wait used to exercise timeout behavior. */
const waitCommand = (milliseconds: number) =>
  `node -e "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${milliseconds})"`;
const SHORT_SLEEP = waitCommand(500);
const OVERRIDE_TIMEOUT_RUN = waitCommand(1500);
/** Long-running command that never finishes on its own. */
const LONG_RUN = IS_WINDOWS ? "for /l %i in (1,1,100000000) do @rem" : "sleep 60";

function args(command: string, workingDir?: string, timeout?: number): string {
  const parts: string[] = [`"command":${JSON.stringify(command)}`];
  if (workingDir !== undefined) parts.push(`"working_dir":${JSON.stringify(workingDir)}`);
  if (timeout !== undefined) parts.push(`"timeout":${timeout}`);
  return "{" + parts.join(",") + "}";
}

async function run(command: string, opts?: { workingDir?: string; timeout?: number; tool?: ReturnType<typeof createBashTool> }) {
  const tool = opts?.tool ?? createBashTool(base);
  return tool.execute(args(command, opts?.workingDir, opts?.timeout));
}

// ---- 正常路径 ----

test("① echo returns exit 0 plus the output", async () => {
  const obs = await run("echo hello");
  assert.equal(obs.isError, false);
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("hello"), obs.text);
});

test("② non-zero exit code is reported as exit: N, not error", async () => {
  const obs = await run("exit 3");
  assert.equal(obs.isError, false);
  assert.ok(obs.text.startsWith("exit: 3"), obs.text);
  assert.ok(!obs.text.startsWith("error:"), obs.text);
});

test("③ unknown command is a normal non-zero exit, not error", async () => {
  const obs = await run("definitely_not_a_real_command_xyz");
  assert.equal(obs.isError, false);
  assert.ok(obs.text.startsWith("exit:"), obs.text);
  assert.ok(!obs.text.startsWith("error:"), obs.text);
});

test("④ stderr is merged into the output", async () => {
  const obs = await run("echo oops 1>&2");
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("oops"), obs.text);
});

test("⑤ working_dir is honored", async () => {
  const sub = join(base, "sub");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "hello.txt"), "from-subdir");
  const obs = await run(IS_WINDOWS ? "type hello.txt" : "cat hello.txt", { workingDir: "sub" });
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("from-subdir"), obs.text);
});

test("⑥ relative working_dir resolves against the base directory", async () => {
  const w = join(base, "w");
  mkdirSync(w, { recursive: true });
  writeFileSync(join(w, "f.txt"), "rel-works");
  const obs = await run(IS_WINDOWS ? "type f.txt" : "cat f.txt", { workingDir: "w" });
  assert.ok(obs.text.includes("rel-works"), obs.text);
});

// ---- 失败路径 ----

test("⑦ timeout returns a structured error mentioning 秒 (injected small default)", async () => {
  const tool = createBashTool(base, { timeoutSeconds: 0.3 });
  const obs = await tool.execute(args(LONG_RUN));
  assert.equal(obs.isError, true);
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("秒"), obs.text);
});

test("⑧ per-call timeout overrides the default and times out", async () => {
  // The 1.5s producer completes under the 5s default but exceeds the 1s override.
  const tool = createBashTool(base, { timeoutSeconds: 5 });
  const obs = await tool.execute(args(OVERRIDE_TIMEOUT_RUN, undefined, 1));
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("秒"), obs.text);
});

test("⑨ per-call timeout longer than the default lets the command complete", async () => {
  // Tool default 300ms kills the 500ms producer; per-call timeout=2 lets it complete.
  const tool = createBashTool(base, { timeoutSeconds: 0.3 });
  const obs = await tool.execute(args(SHORT_SLEEP, undefined, 2));
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
});

test("⑩ invalid timeout argument mentions timeout", async () => {
  const tool = createBashTool(base);
  for (const bad of [0, -3, 99999]) {
    assert.ok((await tool.execute(args("echo x", undefined, bad))).text.includes("timeout"), `timeout=${bad}`);
  }
  const nonInteger = await tool.execute('{"command":"echo x","timeout":"abc"}');
  assert.ok(nonInteger.text.includes("timeout"), nonInteger.text);
});

test("⑪ nonexistent working directory returns an error", async () => {
  const obs = await run("echo x", { workingDir: "no/such/dir" });
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("目录不存在"), obs.text);
});

test("⑪b blank working_dir falls back to the base directory", async () => {
  const obs = await run("echo blank-ok", { workingDir: "   " });
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("blank-ok"), obs.text);
  assert.ok(!obs.text.includes("目录不存在"), obs.text);
});

test("⑪c working_dir pointing at a file is 目录不存在", async () => {
  writeFileSync(join(base, "afile.txt"), "x");
  const obs = await run("echo x", { workingDir: "afile.txt" });
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("目录不存在"), obs.text);
});

test("⑫ missing command argument returns an error mentioning command", async () => {
  const obs = await createBashTool(base).execute("{}");
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("command"), obs.text);
});

test("⑬ invalid JSON returns an error observation", async () => {
  const obs = await createBashTool(base).execute("nope");
  assert.ok(obs.text.startsWith("error:"), obs.text);
});

test("⑭ injected bad shell executable returns 无法启动", async () => {
  const tool = createBashTool(base, { shell: "definitely_not_a_real_exe_xyz" });
  const obs = await tool.execute(args("echo x"));
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("无法启动"), obs.text);
});

// ---- 边界 ----

test("⑮ long output is truncated with the notice and bounded", async () => {
  const big = IS_WINDOWS
    ? "for /l %i in (1,1,500) do @echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    : "head -c 30000 < /dev/zero | tr '\\0' x";
  const obs = await run(big);
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("已截断"), obs.text);
  assert.ok(obs.text.length < 30000, `bounded by head+tail+notice, actual ${obs.text.length}`);
  assert.ok(obs.text.length <= OUTPUT_MAX_BYTES + 300, `respects OUTPUT_MAX_BYTES, actual ${obs.text.length}`);
});

test("⑯ empty-output command is a clean exit 0", async () => {
  const obs = await run(IS_WINDOWS ? "cd" : "true");
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
});

test("⑰ spec.name is the platform shell name and properties.command exists", () => {
  const spec = createBashTool(base).spec;
  assert.equal(spec.name, PLATFORM_SHELL_NAME);
  const properties = spec.parameters.properties as Record<string, { type?: string }>;
  assert.ok(properties.command !== undefined, "properties.command present");
  assert.equal(properties.command.type, "string");
});

// ---- 悲观：引号/特殊字符/工作目录 ----

test("⑱ echo with double quotes has no backslash corruption", async () => {
  const obs = await run('echo "hello world"');
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("hello world"), obs.text);
  assert.ok(!obs.text.includes('\\"'), obs.text);
});

test("⑲ nested quotes preserve meaning (Windows cmd only)", async (t) => {
  if (!IS_WINDOWS) {
    t.skip("sh strips double quotes; only Windows cmd is validated here");
    return;
  }
  const obs = await run(`echo it's "a b" here`);
  assert.ok(obs.text.includes("it's"), obs.text);
  assert.ok(obs.text.includes('"a b"'), obs.text);
  assert.ok(!obs.text.includes("\\"), obs.text);
});

test("⑳ ampersand runs both commands", async () => {
  const obs = await run("echo first & echo second");
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("first"), obs.text);
  assert.ok(obs.text.includes("second"), obs.text);
});

test("㉑ redirection writes the file in the working directory", async () => {
  const obs = await run("echo marker > bash-marker.txt");
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  const path = join(base, "bash-marker.txt");
  assert.ok(existsSync(path), `expected ${path} to be created`);
  assert.ok(readText(path).includes("marker"));
});

test("㉒ %CD% expands to the working directory (Windows cmd only)", async (t) => {
  if (!IS_WINDOWS) {
    t.skip("$PWD has different syntax; only cmd's %CD% is validated here");
    return;
  }
  const obs = await run("echo %CD%");
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes(base), obs.text);
});

test("㉓ empty command returns an error mentioning command", async () => {
  const obs = await createBashTool(base).execute('{"command":""}');
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("command"), obs.text);
});

test("㉔ working_dir containing NUL returns an error, never throws", async () => {
  const obs = await createBashTool(base).execute('{"command":"echo x","working_dir":"bad\\u0000dir"}');
  assert.ok(obs.text.startsWith("error:"), obs.text);
});

// ---- executor 别名 ----

test("session mode omits working_dir and describes persistent cwd/env", async () => {
  const { ShellSession, platformSessionShell } = await import("@di/coding-agent");
  const session = new ShellSession(base, platformSessionShell);
  try {
    const tool = createBashTool(base, { session });
    const properties = tool.spec.parameters.properties as Record<string, { type?: string }>;
    assert.equal(properties.working_dir, undefined);
    assert.ok(tool.spec.description.includes("持久化"), tool.spec.description);
    assert.ok(tool.promptGuidelines.some((line) => line.includes("跨调用保持")), tool.promptGuidelines.join("\n"));
    const obs = await tool.execute(args("echo session-marker"));
    assert.ok(obs.text.includes("session-marker"), obs.text);
  } finally {
    session.dispose();
  }
});

test("executor: platform shell routes under the old 'bash' name on Windows", async (t) => {
  if (!IS_WINDOWS) {
    t.skip("on POSIX the platform name IS bash; alias is a Windows concern");
    return;
  }
  const executor = createToolExecutor([createBashTool(base)]);
  const obs = await executor.execute({
    type: "tool-call",
    id: "a1",
    name: "bash",
    arguments: '{"command":"echo alias-works"}',
  });
  assert.equal(obs.isError, false);
  assert.ok(obs.text.includes("alias-works"), obs.text);
  assert.ok(obs.text.includes("exit: 0"), obs.text);
});

test("executor: unknown tool name returns 未知工具", async () => {
  const executor = createToolExecutor([createBashTool(base)]);
  const obs = await executor.execute({ type: "tool-call", id: "a1", name: "nope", arguments: "{}" });
  assert.equal(obs.isError, true);
  assert.ok(obs.text.includes("未知工具"), obs.text);
});

function readText(path: string): string {
  return readFileSync(path, "utf8");
}
