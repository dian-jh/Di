import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { LockUnavailableError, NativeOsLockProvider } from "../../src/core/auth/lock-provider.ts";
import { CredentialStore, ChatGptCredential } from "../../src/core/auth/credential-store.ts";

async function worker(path: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./native-lock-worker.ts", import.meta.url)), path], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
  const waitFor = async (marker: string, timeoutMs = 5000): Promise<void> => {
    if (output.includes(marker)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`worker timed out waiting for ${marker}: ${output} ${errors}`)), timeoutMs);
      const data = (): void => { if (output.includes(marker)) finish(); };
      const exit = (code: number | null): void => finish(new Error(`worker exited ${code}: ${output} ${errors}`));
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        child.stdout.removeListener("data", data);
        child.removeListener("exit", exit);
        if (error) reject(error); else resolve();
      };
      child.stdout.on("data", data);
      child.once("exit", exit);
      data();
    });
  };
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await waitFor("ATTEMPTING");
  return { child, output: () => output, waitFor, exited };
}

test("native OS lock excludes another process and is released by process death", async () => {
  const directory = await mkdtemp(join(tmpdir(), "di-native-lock-"));
  const path = join(directory, "session.lock");
  const provider = new NativeOsLockProvider({ retryDelayMs: 25 });
  let first: Awaited<ReturnType<typeof worker>> | undefined;
  let second: Awaited<ReturnType<typeof worker>> | undefined;
  try {
    first = await worker(path);
    await first.waitFor("ACQUIRED");
    second = await worker(path);
    await second.waitFor("ATTEMPTING");
    await delay(200);
    assert.equal(second.output().includes("ACQUIRED"), false, "second process must block while first owns OS lock");
    first.child.kill("SIGKILL");
    await first.exited;
    await second.waitFor("ACQUIRED");
    second.child.kill("SIGKILL");
    await second.exited;
  } finally {
    first?.child.kill("SIGKILL");
    if (first !== undefined) await first.exited;
    second?.child.kill("SIGKILL");
    if (second !== undefined) await second.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test("native lock can be acquired repeatedly in one process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "di-native-lock-repeat-"));
  const provider = new NativeOsLockProvider();
  try {
    for (let i = 0; i < 3; i++) {
      const handle = await provider.acquire(join(directory, "session.lock"));
      await handle.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native lock directory creation failure is reported as lock unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "di-native-lock-mkdir-"));
  const blocker = join(directory, "not-a-directory");
  await writeFile(blocker, "synthetic-blocker", "utf8");
  try {
    await assert.rejects(
      new NativeOsLockProvider().acquire(join(blocker, "session.lock")),
      (error: unknown) => error instanceof LockUnavailableError && error.code === "lock-unavailable",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native lock timeout and cancellation preserve the credential bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "di-native-lock-failure-"));
  const path = join(directory, "session.lock");
  const credentials = join(directory, "credentials.json");
  const provider = new NativeOsLockProvider({ retryDelayMs: 10, timeoutMs: 80 });
  const held = await provider.acquire(path);
  try {
    await writeFile(credentials, "synthetic-credential-sentinel", "utf8");
    await assert.rejects(provider.acquire(path), (error: unknown) => error instanceof LockUnavailableError && error.code === "lock-unavailable");
    const controller = new AbortController();
    const pending = provider.acquire(path, { signal: controller.signal, timeoutMs: 1000 });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, (error: unknown) => error instanceof LockUnavailableError && error.code === "lock-unavailable");
    assert.equal(await readFile(credentials, "utf8"), "synthetic-credential-sentinel");
  } finally {
    await held.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cross-process ChatGPT refresh consumes the rotating synthetic token once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "di-native-refresh-"));
  let refreshes = 0;
  const server = createServer(async (request, response) => {
    refreshes++;
    await delay(150);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ access_token: "synthetic-next-access", refresh_token: "synthetic-next-refresh", expires_in: 3600, scope: "openid chatgpt.tokens.use.direct" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/refresh`;
  const store = new CredentialStore({
    lock: new NativeOsLockProvider(),
    acl: { secureDirectory: async () => {}, secureFile: async () => {} },
    directory,
  });
  const children: Array<ReturnType<typeof spawn>> = [];
  try {
    await store.update((data) => {
      data.credential = new ChatGptCredential({
        clientId: "synthetic-client",
        accessToken: "synthetic-expired-access",
        refreshToken: "synthetic-one-time-refresh",
        scopes: ["openid", "chatgpt.tokens.use.direct"],
        expiresAt: Date.now() - 1000,
      });
    });
    const workerPath = fileURLToPath(new URL("./native-refresh-worker.ts", import.meta.url));
    const run = (): Promise<string> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, directory, endpoint], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      children.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`refresh worker timeout: ${stdout} ${stderr}`)); }, 10_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim().replace(/^TOKEN=/, ""));
        else reject(new Error(`refresh worker exited ${code}: ${stdout} ${stderr}`));
      });
    });
    const tokens = await Promise.all([run(), run()]);
    assert.deepEqual(tokens, ["synthetic-next-access", "synthetic-next-access"]);
    assert.equal(refreshes, 1);
    assert.equal((await store.read()).credential?.refreshToken, "synthetic-next-refresh");
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
