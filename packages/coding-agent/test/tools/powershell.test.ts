import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { createPowerShellTool, ShellSession, powershellSessionShell } from "@di/coding-agent";

/**
 *
 * - persistent-session mode (a `ShellSession` with the PowerShell shell is
 *   injected): cd / variables / env persist across calls; `working_dir` is not
 *   in the schema.
 * - one-shot mode (no session): every call runs in a fresh temporary PowerShell
 *   session with an optional `working_dir`.
 *
 * Covers output capture, exit codes, Chinese (UTF-8 stdin/stdout + OEM engine
 * errors), timeout (default + per-call override), working directory, argument /
 * JSON errors, long-output truncation, and no CLIXML pollution.
 *
 * Every case is red by ASSERTION: the exports do not exist yet, so this file
 * fails to load (SyntaxError) — that is the red gate for the card.
 */

const base = mkdtempSync(join(tmpdir(), "di-ps-"));
const powershellExecutable = process.platform === "win32" ? "powershell.exe" : "pwsh";
const hasPowerShell = spawnSync(powershellExecutable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
  stdio: "ignore",
}).error === undefined;

function powerShellTest(name: string, run: () => void | Promise<void>): void {
  test(name, { skip: !hasPowerShell }, run);
}
test.after(async () => {
  // Session kills are fire-and-forget (taskkill tree ~1-2s); a live powershell
  // session still holds `base` as its cwd, so Windows refuses the delete. Retry
  // until the pending kills release the directory (bounded ~6s).
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      rmSync(base, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  rmSync(base, { recursive: true, force: true });
});

function args(command: string, workingDir?: string, timeout?: number): string {
  const parts: string[] = [`"command":${JSON.stringify(command)}`];
  if (workingDir !== undefined) parts.push(`"working_dir":${JSON.stringify(workingDir)}`);
  if (timeout !== undefined) parts.push(`"timeout":${timeout}`);
  return "{" + parts.join(",") + "}";
}

// ---- 正常路径（一次性）----

powerShellTest("① Write-Output returns output and exit 0", async () => {
  const tool = createPowerShellTool(base);
  const obs = await tool.execute(args("Write-Output hello"));
  assert.equal(obs.isError, false);
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("hello"), obs.text);
});

powerShellTest("② non-zero exit code is reported as exit: N, not error", async () => {
  // A native command failure sets $LASTEXITCODE on both Windows and POSIX.
  const command = process.platform === "win32" ? "cmd /c exit 3" : "/bin/sh -c 'exit 3'";
  const obs = await createPowerShellTool(base).execute(args(command));
  assert.ok(obs.text.startsWith("exit: 3"), obs.text);
  assert.ok(!obs.text.startsWith("error:"), obs.text);
});

powerShellTest("③ unknown command is exit 1 with a readable error and no CLIXML", async () => {
  // $? false → fallback rule gives at least 1 (aligned with cmd/bash "not found").
  // Engine error travels stderr (OEM decoded); must not be CLIXML XML.
  const obs = await createPowerShellTool(base).execute(args("definitely_not_a_real_command_xyz"));
  assert.ok(obs.text.startsWith("exit: 1"), obs.text);
  assert.ok(obs.text.includes("definitely_not_a_real_command_xyz"), obs.text);
  assert.ok(!obs.text.includes("CLIXML"), obs.text);
});

powerShellTest("④ Chinese output round-trips through stdin (UTF-8) and stdout (UTF-8)", async () => {
  const obs = await createPowerShellTool(base).execute(args('Write-Output "你好世界"'));
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("你好世界"), obs.text);
});

powerShellTest("⑤ working directory is honored", async () => {
  mkdirSync(join(base, "sub"), { recursive: true });
  const obs = await createPowerShellTool(base).execute(args("(Get-Location).Path", "sub"));
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("sub"), obs.text);
});

powerShellTest("⑥ relative working directory resolves against the base directory", async () => {
  mkdirSync(join(base, "w"), { recursive: true });
  const obs = await createPowerShellTool(base).execute(args("(Get-Location).Path", "w"));
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("w"), obs.text);
});

// ---- 失败路径 ----

powerShellTest("⑦ timeout returns a structured error mentioning 秒", async () => {
  const tool = createPowerShellTool(base, { timeoutSeconds: 0.3 });
  const obs = await tool.execute(args("Start-Sleep -Seconds 5"));
  assert.equal(obs.isError, true);
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("秒"), obs.text);
});

powerShellTest("⑧ per-call timeout overrides the default and times out", async () => {
  const tool = createPowerShellTool(base, { timeoutSeconds: 5 });
  const obs = await tool.execute(args("Start-Sleep -Seconds 5", undefined, 1));
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("秒"), obs.text);
});

powerShellTest("⑨ per-call timeout longer than the default lets the command complete", async () => {
  const tool = createPowerShellTool(base, { timeoutSeconds: 0.3 });
  const obs = await tool.execute(args("Start-Sleep -Milliseconds 300", undefined, 2));
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
});

powerShellTest("⑩ invalid timeout arguments mention timeout", async () => {
  const tool = createPowerShellTool(base);
  for (const bad of [0, -3, 99999]) {
    assert.ok((await tool.execute(args("Write-Output x", undefined, bad))).text.includes("timeout"), `timeout=${bad}`);
  }
  const nonInteger = await tool.execute('{"command":"Write-Output x","timeout":"abc"}');
  assert.ok(nonInteger.text.includes("timeout"), nonInteger.text);
});

powerShellTest("⑪ nonexistent working directory returns an error", async () => {
  const obs = await createPowerShellTool(base).execute(args("Write-Output x", "no/such/dir"));
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("目录不存在"), obs.text);
});

powerShellTest("⑫ missing command argument returns an error mentioning command", async () => {
  const obs = await createPowerShellTool(base).execute("{}");
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("command"), obs.text);
});

powerShellTest("⑬ invalid JSON returns an error observation", async () => {
  const obs = await createPowerShellTool(base).execute("nope");
  assert.ok(obs.text.startsWith("error:"), obs.text);
});

test("⑭ nonexistent shell executable returns 无法启动", async () => {
  const session = new ShellSession(base, {
    file: "definitely_not_a_real_exe_xyz",
    prefixArgs: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
    sessionKind: "powershell",
  });
  const tool = createPowerShellTool(base, { session });
  try {
    const obs = await tool.execute(args("Write-Output x"));
    assert.ok(obs.text.startsWith("error:"), obs.text);
    assert.ok(obs.text.includes("无法启动"), obs.text);
  } finally {
    session.dispose();
  }
});

// ---- 边界 ----

powerShellTest("⑮ long output is truncated with the notice and bounded", async () => {
  const big = "1..500 | ForEach-Object { \"a\" * 60 }";
  const obs = await createPowerShellTool(base).execute(args(big));
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("已截断"), obs.text);
  assert.ok(obs.text.length < 30000, `bounded by head+tail+notice, actual ${obs.text.length}`);
});

powerShellTest("⑯ empty command output is a clean exit 0", async () => {
  const obs = await createPowerShellTool(base).execute(args("Write-Output $null"));
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
});

powerShellTest("⑰ definition has name powershell and a command property", () => {
  const spec = createPowerShellTool(base).spec;
  assert.equal(spec.name, "powershell");
  const properties = spec.parameters.properties as Record<string, { type?: string }>;
  assert.ok(properties.command !== undefined, "properties.command present");
  assert.equal(properties.command.type, "string");
});

// ---- 悲观：引号/特殊字符/工作目录 ----

powerShellTest("⑱ double quotes survive stdin without backslash corruption", async () => {
  const obs = await createPowerShellTool(base).execute(args('Write-Output "hello world"'));
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("hello world"), obs.text);
  assert.ok(!obs.text.includes('\\"'), obs.text);
});

powerShellTest("⑲ semicolon runs both statements", async () => {
  const obs = await createPowerShellTool(base).execute(
    args("Write-Output 'first'; Write-Output 'second'"),
  );
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  assert.ok(obs.text.includes("first"), obs.text);
  assert.ok(obs.text.includes("second"), obs.text);
});

powerShellTest("⑳ redirection writes the file in the working directory", async () => {
  const obs = await createPowerShellTool(base).execute(
    args("Set-Content -Path ps-marker.txt -Value 'marker'"),
  );
  assert.ok(obs.text.startsWith("exit: 0"), obs.text);
  const path = join(base, "ps-marker.txt");
  assert.ok(existsSync(path), `expected ${path} to be created`);
  assert.ok(readFileSync(path, "utf8").includes("marker"));
});

powerShellTest("㉑ empty command returns an error mentioning command", async () => {
  const obs = await createPowerShellTool(base).execute('{"command":""}');
  assert.ok(obs.text.startsWith("error:"), obs.text);
  assert.ok(obs.text.includes("command"), obs.text);
});

powerShellTest("㉒ working_dir containing NUL returns an error, never throws", async () => {
  const obs = await createPowerShellTool(base).execute('{"command":"Write-Output x","working_dir":"bad\\u0000dir"}');
  assert.ok(obs.text.startsWith("error:"), obs.text);
});

// ---- 悲观：持久化会话模式 ----

powerShellTest("㉓ with a session, state persists across calls", async () => {
  mkdirSync(join(base, "work"), { recursive: true });
  const session = new ShellSession(base, powershellSessionShell);
  const tool = createPowerShellTool(base, { session });
  try {
    await tool.execute(args("cd work"));
    const result = await tool.execute(args("(Get-Location).Path"));
    assert.ok(result.text.startsWith("exit: 0"), result.text);
    assert.ok(result.text.includes("work"), result.text);
  } finally {
    session.dispose();
  }
});

powerShellTest("㉔ with a session, the working_dir param is ignored", async () => {
  const session = new ShellSession(base, powershellSessionShell);
  const tool = createPowerShellTool(base, { session });
  try {
    await tool.execute(args("$env:DI_T='yes'", "sub/that/does/not/exist"));
    const result = await tool.execute(args("Write-Output $env:DI_T", "sub/that/does/not/exist"));
    assert.ok(result.text.includes("yes"), result.text);
  } finally {
    session.dispose();
  }
});

powerShellTest("㉕ with a session, the definition omits working_dir and describes persistence", () => {
  const session = new ShellSession(base, powershellSessionShell);
  const spec = createPowerShellTool(base, { session }).spec;
  assert.equal(spec.name, "powershell");
  const properties = spec.parameters.properties as Record<string, unknown>;
  assert.ok(properties.command !== undefined, "properties.command present");
  assert.ok(properties.working_dir === undefined, "no working_dir in session mode");
  assert.ok(spec.description.includes("持久化"), spec.description);
});

powerShellTest("㉖ with a session, timeout self-heals", async () => {
  const session = new ShellSession(base, powershellSessionShell);
  const tool = createPowerShellTool(base, { session, timeoutSeconds: 0.3 });
  try {
    const timedOut = await tool.execute(args("Start-Sleep -Seconds 5"));
    assert.ok(timedOut.text.startsWith("error:"), timedOut.text);
    assert.ok(timedOut.text.includes("秒"), timedOut.text);
    const after = await tool.execute(args("Write-Output recovered"));
    assert.ok(after.text.startsWith("exit: 0"), after.text);
    assert.ok(after.text.includes("recovered"), after.text);
  } finally {
    session.dispose();
  }
});

powerShellTest("㉗ with a session, unknown command returns exit 1", async () => {
  const session = new ShellSession(base, powershellSessionShell);
  const tool = createPowerShellTool(base, { session });
  try {
    const result = await tool.execute(args("definitely_not_a_real_command_xyz"));
    assert.ok(result.text.startsWith("exit: 1"), result.text);
    assert.ok(!result.text.startsWith("error:"), result.text);
  } finally {
    session.dispose();
  }
});
