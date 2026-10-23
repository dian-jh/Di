import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ShellSession } from "@di/coding-agent";

/**
 * Commands run through stdin/stdout, where cwd, environment variables and virtual-env state
 * survive across calls. Per the contract (tools-and-platform.md §"持久 shell
 * 会话协议"): lazy spawn, random nonce marker round-trip, stdin encoding, bounded
 * stdout/stderr drain, an async mutex serializing commands, and kill/recreate on
 * timeout / user `exit` / cancel.
 *
 * Platform-aware commands: the acceptance platform is Windows (cmd session), so
 * the Windows branches run here; POSIX branches (`sleep` / `printf`) are written
 * but skipped on this machine.
 */

const base = mkdtempSync(join(tmpdir(), "di-session-"));
const sub = join(base, "work");
mkdirSync(sub, { recursive: true });
mkdirSync(join(base, "other"), { recursive: true });
test.after(async () => {
  // Session kills are fire-and-forget (taskkill tree ~1-2s); a session cmd that
  // is still alive holds `base` as its cwd, so Windows refuses the delete. Retry
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

const IS_WINDOWS = process.platform === "win32";
const TIMEOUT_MS = 10_000;

const cd = (): string => (IS_WINDOWS ? "cd" : "pwd");
const longRun = (): string =>
  IS_WINDOWS ? "for /l %i in (1,1,100000000) do @rem" : "sleep 60";
const noTrailingNewline = (): string => (IS_WINDOWS ? "<nul set /p=x" : "printf x");

function obs(result: { toObservation(): string }): string {
  return result.toObservation();
}

// ---- 基本执行 ----

test("① simple command returns output and exit 0", async () => {
  const session = new ShellSession(base);
  const result = await session.execute("echo hello", TIMEOUT_MS);
  session.dispose();
  assert.ok(obs(result).startsWith("exit: 0"), obs(result));
  assert.ok(obs(result).includes("hello"), obs(result));
});

test("② initial working directory is used", async () => {
  const session = new ShellSession(sub);
  const result = await session.execute(cd(), TIMEOUT_MS);
  session.dispose();
  assert.ok(obs(result).includes("work"), obs(result));
});

test("③ non-zero exit is reported", async () => {
  const session = new ShellSession(base);
  const command = IS_WINDOWS ? "cmd /c exit 3" : "false";
  const expected = IS_WINDOWS ? "exit: 3" : "exit: 1";
  const result = await session.execute(command, TIMEOUT_MS);
  session.dispose();
  assert.ok(obs(result).startsWith(expected), obs(result));
});

// ---- 状态持久化（第五章核心） ----

test("④ cwd persists across commands", async () => {
  const session = new ShellSession(base);
  await session.execute("cd work", TIMEOUT_MS);
  const result = await session.execute(cd(), TIMEOUT_MS);
  session.dispose();
  assert.ok(obs(result).includes("work"), obs(result));
});

test("⑤ environment variable persists across commands", async () => {
  const session = new ShellSession(base);
  const set = IS_WINDOWS ? "set DI_VAR=abc" : "export DI_VAR=abc";
  const read = IS_WINDOWS ? "echo %DI_VAR%" : "echo $DI_VAR";
  await session.execute(set, TIMEOUT_MS);
  const result = await session.execute(read, TIMEOUT_MS);
  session.dispose();
  assert.ok(obs(result).includes("abc"), obs(result));
});

test("⑥ subsequent cd overrides the previous one", async () => {
  const session = new ShellSession(base);
  const cdTo = (dir: string): string =>
    IS_WINDOWS ? `cd /d "${dir}"` : `cd '${dir}'`;
  await session.execute(cdTo(sub), TIMEOUT_MS);
  await session.execute(cdTo(join(base, "other")), TIMEOUT_MS);
  const result = await session.execute(cd(), TIMEOUT_MS);
  session.dispose();
  assert.ok(obs(result).includes("other"), obs(result));
  assert.ok(!obs(result).includes("work"), obs(result));
});

// ---- 输出边界 ----

test("⑦ multiline output is collected in order", async () => {
  const session = new ShellSession(base);
  const command = IS_WINDOWS
    ? "echo one & echo two & echo three"
    : "printf 'one\\ntwo\\nthree\\n'";
  const result = await session.execute(command, TIMEOUT_MS);
  session.dispose();
  const text = obs(result);
  const i1 = text.indexOf("one");
  const i2 = text.indexOf("two");
  const i3 = text.indexOf("three");
  assert.ok(i1 >= 0 && i2 > i1 && i3 > i2, `output order scrambled: ${text}`);
});

test("⑧ output without a trailing newline does not hang", async () => {
  const session = new ShellSession(base);
  // The marker line is glued onto the same line as the no-newline output; the
  // parser must still find the boundary and keep the leading bytes.
  const result = await session.execute(noTrailingNewline(), TIMEOUT_MS);
  session.dispose();
  assert.ok(obs(result).startsWith("exit:"), obs(result));
  assert.ok(obs(result).includes("x"), obs(result));
});

test("⑨ empty command still returns the marker / exit 0", async () => {
  const session = new ShellSession(base);
  const result = await session.execute("", TIMEOUT_MS);
  session.dispose();
  assert.ok(obs(result).startsWith("exit: 0"), obs(result));
});

test("⑨b user output that merely resembles a marker does not end the command early", async () => {
  const session = new ShellSession(base);
  const command = IS_WINDOWS
    ? "echo DI_END_FOO & echo DI_END_BAR_exit:7"
    : "printf 'DI_END_FOO\\nDI_END_BAR_exit:7\\n'";
  const result = await session.execute(command, TIMEOUT_MS);
  session.dispose();
  assert.ok(obs(result).startsWith("exit: 0"), obs(result));
  assert.ok(obs(result).includes("DI_END_FOO"), obs(result));
  assert.ok(obs(result).includes("DI_END_BAR_exit:7"), obs(result));
});

test("⑨c concurrent executes serialize through the session mutex", async () => {
  const session = new ShellSession(base);
  const [r1, r2] = await Promise.all([
    session.execute("echo one", TIMEOUT_MS),
    session.execute("echo two", TIMEOUT_MS),
  ]);
  session.dispose();
  assert.ok(obs(r1).startsWith("exit: 0"), obs(r1));
  assert.ok(obs(r1).includes("one"), obs(r1));
  assert.ok(obs(r2).startsWith("exit: 0"), obs(r2));
  assert.ok(obs(r2).includes("two"), obs(r2));
});

test("⑨d an old command nonce printed by a later command is ordinary output", async () => {
  const shellScript = String.raw`
let previousExit = "";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  for (;;) {
    const at = input.indexOf("\n");
    if (at < 0) break;
    const line = input.slice(0, at).replace(/\r$/, "");
    input = input.slice(at + 1);
    const ready = line.match(/^echo (DI_[0-9a-f]+ready)$/);
    if (ready) { process.stdout.write(ready[1] + "\n"); continue; }
    const marker = line.match(/echo (DI_END_[0-9a-f]+); echo (DI_END_[0-9a-f]+_exit):\$__di_rc/);
    if (marker) {
      process.stdout.write(marker[1] + "\n" + marker[2] + ":0\n");
      previousExit = marker[2];
      continue;
    }
    if (line === "trace-first") process.stdout.write("first-command\n");
    else if (line === "emit-old") process.stdout.write("\n" + previousExit + ":7\ncommand-finished\n");
    else process.stdout.write(line + "\n");
  }
});
`;
  const session = new ShellSession(base, { file: process.execPath, prefixArgs: ["-e", shellScript], sessionKind: "sh" });
  try {
    const first = await session.execute("trace-first", TIMEOUT_MS);
    assert.equal(first.exitCode, 0, obs(first));
    const printed = await session.execute("emit-old", TIMEOUT_MS);
    assert.equal(printed.exitCode, 0, obs(printed));
    assert.match(printed.output, /DI_END_[0-9a-f]{32}_exit:7/, obs(printed));
    assert.ok(printed.output.includes("command-finished"), obs(printed));

    const following = await session.execute("echo following-command", TIMEOUT_MS);
    assert.equal(following.exitCode, 0, obs(following));
    assert.ok(obs(following).includes("following-command"), obs(following));
  } finally {
    session.dispose();
  }
});

// ---- 失败/自愈 ----

test("⑩ timeout kills the session and the next call self-heals", async () => {
  const session = new ShellSession(base);
  const result = await session.execute(longRun(), 300);
  assert.ok(obs(result).startsWith("error:"), obs(result));
  assert.ok(obs(result).includes("秒"), obs(result));

  const after = await session.execute("echo after-timeout", TIMEOUT_MS);
  session.dispose();
  assert.ok(obs(after).startsWith("exit: 0"), obs(after));
  assert.ok(obs(after).includes("after-timeout"), obs(after));
});

test("⑪ user exit ends the session and the next call respawns", async () => {
  const session = new ShellSession(base);
  await session.execute("exit 0", TIMEOUT_MS);
  const after = await session.execute("echo after-exit", TIMEOUT_MS);
  session.dispose();
  assert.ok(obs(after).startsWith("exit: 0"), obs(after));
  assert.ok(obs(after).includes("after-exit"), obs(after));
});

// ---- 边界 ----

test("⑫ long output is truncated with the notice", async () => {
  const session = new ShellSession(base);
  const big = `node -e "process.stdout.write('x'.repeat(30000))"`;
  const result = await session.execute(big, TIMEOUT_MS);
  session.dispose();
  assert.ok(obs(result).startsWith("exit: 0"), obs(result));
  assert.ok(obs(result).includes("已截断"), obs(result));
  assert.ok(obs(result).length < 30000, `bounded, actual ${obs(result).length}`);
});

test("⑬ dispose kills the session process", async () => {
  const session = new ShellSession(base);
  await session.execute("echo hi", TIMEOUT_MS);
  assert.ok(session.isAlive, "session alive after a command");
  session.dispose();
  assert.ok(!session.isAlive, "session dead after dispose");
});

test("initialization abort interrupts a pending ready read", async () => {
  const shellScript = String.raw`
process.stdin.resume();
// Deliberately remain alive and never emit the readiness marker.
setInterval(() => {}, 1000);
`;
  const session = new ShellSession(base, {
    file: process.execPath,
    prefixArgs: ["-e", shellScript],
    sessionKind: "sh",
  });
  const controller = new AbortController();
  const execution = session.execute("unused", TIMEOUT_MS, controller.signal);
  let watchdogTimer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    watchdogTimer = setTimeout(() => reject(new Error("initialization abort watchdog expired")), 8_000);
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await assert.rejects(Promise.race([execution, watchdog]), { name: "AbortError" });
  } finally {
    clearTimeout(watchdogTimer);
    session.dispose();
  }
});

test("initialization timeout interrupts a pending ready read", async () => {
  const shellScript = String.raw`
process.stdin.resume();
setInterval(() => {}, 1000);
`;
  const session = new ShellSession(base, {
    file: process.execPath,
    prefixArgs: ["-e", shellScript],
    sessionKind: "sh",
  });
  let watchdogTimer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    watchdogTimer = setTimeout(() => reject(new Error("initialization timeout watchdog expired")), 20_000);
  });
  try {
    const result = await Promise.race([session.execute("unused", TIMEOUT_MS), watchdog]);
    assert.ok(result.error, "initialization timeout is reported");
    assert.match(result.error, /初始化超时/);
  } finally {
    clearTimeout(watchdogTimer);
    session.dispose();
  }
});

test("PowerShell session startup sets TERM=dumb for redirected protocol output", async () => {
  const shellScript = String.raw`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  for (;;) {
    const at = input.indexOf("\n");
    if (at < 0) break;
    const line = input.slice(0, at).replace(/\r$/, "");
    input = input.slice(at + 1);
    const ready = line.match(/^echo (DI_[0-9a-f]+ready)$/);
    if (ready) {
      if (process.env.TERM === "dumb") process.stdout.write(ready[1] + "\n");
      else process.stdout.write("\x1b[?1h");
      continue;
    }
    const marker = line.match(/Write-Output '((DI_END_[0-9a-f]+))'; Write-Output \('((DI_END_[0-9a-f]+_exit)):/);
    if (marker) process.stdout.write(marker[1] + "\n" + marker[3] + ":0\n");
  }
});
`;
  const session = new ShellSession(base, {
    file: process.execPath,
    prefixArgs: ["-e", shellScript],
    sessionKind: "powershell",
  });
  let watchdogTimer: NodeJS.Timeout | undefined;
  const previousTerm = process.env.TERM;
  process.env.TERM = "xterm";
  const execution = session.execute("probe", TIMEOUT_MS);
  const watchdog = new Promise<never>((_, reject) => {
    watchdogTimer = setTimeout(() => reject(new Error("PowerShell startup watchdog expired")), 8_000);
  });
  try {
    const result = await Promise.race([execution, watchdog]);
    assert.equal(result.exitCode, 0, obs(result));
    assert.equal(process.env.TERM, "xterm", "the parent TERM value is unchanged");
  } finally {
    clearTimeout(watchdogTimer);
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
    session.dispose();
  }
});
