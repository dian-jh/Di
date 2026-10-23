import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CredentialStore, FAIL_CLOSED_LOCK_PROVIDER, LockUnavailableError, type LockHandle } from "@di/coding-agent";
import { mockLockProvider, noopAcl } from "./test-doubles.ts";

/**
 * Credentials are protected by a real OS advisory lock (Windows LockFileEx /
 * POSIX flock) held across read →
 * cross-platform adapter is acceptable (proper-lockfile/lockfile are mkdir/TTL —
 * forbidden; fs-ext needs a native node-gyp build, not distributed), so the
 * CONTRACT-MANDATED default is FAIL CLOSED: acquire() rejects with a recoverable
 * error, credentials are preserved, the store never proceeds unlocked, and stale
 * locks are never auto-recovered by PID/age. `open('wx')` existence locks are
 * forbidden because a crash can leave a permanent deadlock.
 */

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "di-p8b-lock-"));
}

test("default lock provider fails closed with a recoverable error", async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(
      FAIL_CLOSED_LOCK_PROVIDER.acquire(join(dir, "session.lock")),
      (error: unknown) => error instanceof LockUnavailableError && error.code === "lock-unavailable",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fail-closed acquire never creates a lock file (no `open('wx')` existence lock)", async () => {
  const dir = await tempDir();
  try {
    await FAIL_CLOSED_LOCK_PROVIDER.acquire(join(dir, "session.lock")).catch(() => {});
    const entries = await readdir(dir);
    assert.deepEqual(entries, [], "the fail-closed provider must not create or touch any file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store read through the default provider surfaces the recoverable error and preserves credentials", async () => {
  const dir = await tempDir();
  try {
    const credentialsPath = join(dir, "credentials.json");
    await writeFile(credentialsPath, JSON.stringify({ hostId: "urn:uuid:keep" }), "utf8");
    const store = new CredentialStore({
      lock: FAIL_CLOSED_LOCK_PROVIDER,
      acl: noopAcl,
      directory: dir,
    });
    await assert.rejects(store.read(), (e: unknown) => e instanceof LockUnavailableError);
    await assert.rejects(
      store.update(async () => {}),
      (e: unknown) => e instanceof LockUnavailableError,
    );
    const preserved = JSON.parse(await readFile(credentialsPath, "utf8")) as { hostId: string };
    assert.equal(preserved.hostId, "urn:uuid:keep", "fail-closed must not touch credentials");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a DI-injected lock provider is honored by the store (acquire with the lock path, release awaited)", async () => {
  const dir = await tempDir();
  try {
    const lock = mockLockProvider();
    const store = new CredentialStore({ lock, acl: noopAcl, directory: dir });
    await store.update((data) => {
      data.hostId = "urn:uuid:written";
    });
    assert.equal(lock.acquireCalls, 1);
    assert.equal(lock.isHeld(), false, "the store must release the lock after the transaction");
    const data = await store.read();
    assert.equal(data.hostId, "urn:uuid:written");
    assert.equal(lock.acquireCalls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the mock lock serializes concurrent acquisitions (cross-process stand-in)", async () => {
  const lock = mockLockProvider();
  const acquired: number[] = [];
  const handles: LockHandle[] = [];
  const p1 = lock.acquire("x").then((h) => {
    handles.push(h);
    acquired.push(1);
  });

  const p2 = lock.acquire("x").then((h) => {
    handles.push(h);
    acquired.push(2);
  });
  await p1;
  assert.deepEqual(acquired, [1]);
  assert.equal(lock.isHeld(), true);
  await handles[0]!.release();
  await p2;
  assert.deepEqual(acquired, [1, 2], "second acquire must wait for the first holder to release");
  await handles[1]!.release();
  assert.equal(lock.isHeld(), false);
});
