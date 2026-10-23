import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 *
 * compiled entry with `--mode rpc` (the exact way the TS TUI's `Launcher` will
 *
 * on stdout, then drive a clean shutdown and expect exit 0.
 *
 * Independent child process, isolated temp DI_HOME, synthetic credentials only
 *
 * child-test-host pattern (packages/coding-agent/test/child-test-host/host.mjs).
 */

const node = process.execPath;
const cwd = process.cwd();
const entry = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

/** A line reader over a stdout/stderr stream with a per-line budget. */
interface LineReader {
  nextLine(budgetMs: number): Promise<string | null>;
}

function createLineReader(stream: NodeJS.ReadableStream): LineReader {
  let buffer = "";
  let ended = false;
  const waiters: Array<(line: string | null) => void> = [];
  stream.setEncoding("utf8");

  const onData = (chunk: string): void => {
    buffer += chunk;
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (waiters.length > 0) waiters.shift()!(line);
    }
  };
  const onEnd = (): void => {
    ended = true;
    while (waiters.length > 0) waiters.shift()!(null);
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  stream.on("close", onEnd);

  return {
    nextLine(budgetMs: number): Promise<string | null> {
      return new Promise((resolve) => {
        const nl = buffer.indexOf("\n");
        if (nl >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          resolve(line);
          return;
        }
        if (ended) {
          resolve(null);
          return;
        }
        const worker = (line: string | null): void => {
          clearTimeout(timer);
          resolve(line);
        };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(worker);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve(null);
        }, budgetMs);
        waiters.push(worker);
      });
    },
  };
}

/** Wait for the child to exit (or fail); kills it on budget expiry. */
function waitExit(child: ChildProcess, budgetMs: number): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child did not exit within ${budgetMs}ms`));
    }, budgetMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, error });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
}

test("CLI bin: spawns rpc mode, emits the ready handshake, shuts down cleanly with exit 0", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-bin-"));
  const child = spawn(node, [entry, "--mode", "rpc"], {
    cwd,
    env: { ...process.env, DI_HOME: diHome, DEEPSEEK_API_KEY: "" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    const stdout = createLineReader(child.stdout!);
    const readyLine = await stdout.nextLine(15_000);
    assert.ok(readyLine !== null, "the ready handshake line must arrive on stdout");

    const ready = JSON.parse(readyLine) as { type?: string; model?: string };
    assert.equal(ready.type, "ready", "first NDJSON line is the ready handshake");
    assert.equal(typeof ready.model, "string", "ready carries the current model label");

    child.stdin!.write(JSON.stringify({ method: "shutdown", params: {} }) + "\n");
    child.stdin!.end();

    const { code, error } = await waitExit(child, 15_000);
    assert.equal(error, undefined, `child must start and exit cleanly (${error ?? ""})`);
    assert.equal(code, 0, "clean shutdown exits 0");
  } finally {
    child.kill();
    rmSync(diHome, { recursive: true, force: true });
  }
});

test("CLI bin: stdin EOF in rpc mode finishes and exits 0", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-bin-"));
  const child = spawn(node, [entry, "--mode", "rpc"], {
    cwd,
    env: { ...process.env, DI_HOME: diHome, DEEPSEEK_API_KEY: "" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    const stdout = createLineReader(child.stdout!);
    const readyLine = await stdout.nextLine(15_000);
    assert.ok(readyLine !== null, "ready handshake expected");
    assert.equal(JSON.parse(readyLine).type, "ready");

    child.stdin!.end(); // EOF: the RPC loop finishes the current turn then exits 0.

    const { code, error } = await waitExit(child, 15_000);
    assert.equal(error, undefined, `child must start and exit cleanly (${error ?? ""})`);
    assert.equal(code, 0, "stdin EOF exits 0");
  } finally {
    child.kill();
    rmSync(diHome, { recursive: true, force: true });
  }
});
