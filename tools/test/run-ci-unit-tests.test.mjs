import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCiUnitTests } from "../run-ci-unit-tests.mjs";

test("kills a child that keeps an open handle past the deadline", async () => {
  const exitCode = await runCiUnitTests({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 100,
  });

  assert.equal(exitCode, 1);
});

test("kills a hanging grandchild with its parent", { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "di-ci-runner-test-"));
  const marker = join(directory, "grandchild.pid");
  let grandchildPid;
  try {
    const parent = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const exitCode = await runCiUnitTests({ command: process.execPath, args: ["-e", parent], timeoutMs: 2_500 });
    assert.equal(exitCode, 1);
    assert.ok(existsSync(marker), "grandchild started and recorded its PID");
    grandchildPid = Number(readFileSync(marker, "utf8"));
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try { process.kill(grandchildPid, 0); } catch (error) {
        if (error.code === "ESRCH") return;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`grandchild ${grandchildPid} survived the timeout`);
  } finally {
    if (grandchildPid) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(grandchildPid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      } else {
        try { process.kill(grandchildPid, "SIGKILL"); } catch {}
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves a normal child failure code", async () => {
  const exitCode = await runCiUnitTests({
    command: process.execPath,
    args: ["-e", "process.exit(7)"],
    timeoutMs: 2_000,
  });

  assert.equal(exitCode, 7);
});
