import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CredentialDataError, CredentialStore, needsRefresh, ChatGptCredential, type CredentialStoreOptions } from "@di/coding-agent";
import { mockLockProvider, noopAcl, recordingAcl, failingFileAcl } from "./test-doubles.ts";

/**
 *
 * The ONLY write path is `update(change)`: acquire cross-process exclusive lock →
 * re-read latest credentials INSIDE the lock → apply change → validate → atomic
 * replace (unique temp file in the same dir → write → fh.sync() → close → rename
 * overwrite; on failure the old file is preserved and the orphan temp cleaned).
 * Tests use the mocked lock to verify the transaction logic exactly; the real
 * OS-advisory-lock adapter stays out of scope (fail-closed default).
 */

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "di-p8b-store-"));
}

function makeStore(dir: string, overrides: Partial<CredentialStoreOptions> = {}) {
  return new CredentialStore({
    lock: mockLockProvider(),
    acl: noopAcl,
    directory: dir,
    ...overrides,
  });
}

test("fresh store read returns an empty host + no credential without creating the file", async () => {
  const dir = await tempDir();
  try {
    const store = makeStore(dir);
    const data = await store.read();
    assert.match(data.hostId, /^urn:uuid:/);
    assert.equal(data.credential, undefined);
    const entries = await readdir(dir);
    assert.deepEqual(entries, [], "read on an empty store must not create credentials.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("update writes credentials atomically and returns the mutated data", async () => {
  const dir = await tempDir();
  try {
    const store = makeStore(dir);
    const acl = recordingAcl();
    const secureStore = new CredentialStore({ lock: mockLockProvider(), acl, directory: dir });
    const data = await secureStore.update((d) => {
      d.hostId = "urn:uuid:hello";
      d.credential = new ChatGptCredential({
        clientId: "oaiapp_test",
        accessToken: "access-initial",
        refreshToken: "refresh-initial",
        scopes: ["chatgpt.tokens.use.direct"],
        expiresAt: Date.now() + 3_600_000,
      });
    });
    assert.equal(data.hostId, "urn:uuid:hello");
    assert.equal(data.credential?.accessToken, "access-initial");

    const onDisk = JSON.parse(await readFile(join(dir, "credentials.json"), "utf8")) as {
      hostId: string;
      credential: { clientId: string };
    };
    assert.equal(onDisk.hostId, "urn:uuid:hello");
    assert.equal(onDisk.credential.clientId, "oaiapp_test");
    // The ACL seam was applied to both the directory and the temp file.
    assert.equal(acl.calls.some((c) => c.op === "dir"), true);
    assert.equal(acl.calls.some((c) => c.op === "file"), true);
    // No orphan temp files after a successful write.
    const entries = await readdir(dir);
    assert.equal(entries.filter((f) => f.endsWith(".tmp")).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("update re-reads the latest credentials inside the lock (second writer sees the first)", async () => {
  const dir = await tempDir();
  try {
    const lock = mockLockProvider();
    const a = new CredentialStore({ lock, acl: noopAcl, directory: dir });
    const b = new CredentialStore({ lock, acl: noopAcl, directory: dir });
    await a.update((d) => {
      d.hostId = "urn:uuid:first";
    });
    // This is the guarantee that prevents double refresh-token consumption: B's
    // change callback sees A's committed write, not a stale snapshot.
    await b.update((d) => {
      assert.equal(d.hostId, "urn:uuid:first");
      d.hostId = "urn:uuid:second";
    });
    const final = await a.read();
    assert.equal(final.hostId, "urn:uuid:second");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("update change throwing leaves the old file preserved and no temp orphan", async () => {
  const dir = await tempDir();
  try {
    const store = makeStore(dir);
    await store.update((d) => {
      d.hostId = "urn:uuid:original";
    });
    const path = join(dir, "credentials.json");
    const before = await readFile(path, "utf8");
    await assert.rejects(
      store.update(() => {
        throw new Error("change boom");
      }),
    );
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal((await readdir(dir)).filter((f) => f.endsWith(".tmp")).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("atomic replace: rename failure (crash before commit) keeps the old file and cleans the temp", async () => {
  const dir = await tempDir();
  try {
    const store = makeStore(dir);
    await store.update((d) => {
      d.hostId = "urn:uuid:v1";
    });
    const path = join(dir, "credentials.json");
    const before = await readFile(path, "utf8");

    const crashingStore = new CredentialStore({
      lock: mockLockProvider(),
      acl: noopAcl,
      directory: dir,
      rename: async () => {
        throw new Error("simulated crash before rename");
      },
    });
    await assert.rejects(
      crashingStore.update((d) => {
        d.hostId = "urn:uuid:v2";
      }),
    );
    assert.equal(await readFile(path, "utf8"), before, "old credentials must survive a crash before rename");
    assert.equal((await readdir(dir)).filter((f) => f.endsWith(".tmp")).length, 0, "orphan temp must be cleaned");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ACL failure refuses the token write (fail closed, old file kept)", async () => {
  const dir = await tempDir();
  try {
    const store = makeStore(dir);
    await store.update((d) => {
      d.hostId = "urn:uuid:original";
    });
    const path = join(dir, "credentials.json");
    const before = await readFile(path, "utf8");
    const refusing = new CredentialStore({
      lock: mockLockProvider(),
      acl: failingFileAcl(new Error("icacls verify failed")),
      directory: dir,
    });
    await assert.rejects(refusing.update((d) => { d.hostId = "urn:uuid:evil"; }));
    assert.equal(await readFile(path, "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy credential format (PascalCase Accounts/ActiveClientId) is migrated preserving the active credential", async () => {
  const dir = await tempDir();
  try {
    const legacy = {
      HostId: "urn:uuid:legacy-host",
      Accounts: [
        { ClientId: "oaiapp_old", AccessToken: "old", Scopes: ["chatgpt.tokens.use.direct"], ExpiresAt: "2026-01-01T00:00:00.0000000+00:00" },
        { ClientId: "oaiapp_test", AccessToken: "access-initial", RefreshToken: "refresh-initial", Scopes: ["chatgpt.tokens.use.direct"], ExpiresAt: "2099-01-01T00:00:00.0000000+00:00" },
      ],
      ActiveClientId: "oaiapp_test",
    };
    await writeFile(join(dir, "credentials.json"), JSON.stringify(legacy), "utf8");
    const store = makeStore(dir);
    const data = await store.read();
    assert.equal(data.hostId, "urn:uuid:legacy-host");
    assert.equal(data.credential?.clientId, "oaiapp_test");
    assert.equal(data.credential?.accessToken, "access-initial");
    assert.equal(data.credential?.refreshToken, "refresh-initial");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt credentials file is reported, never silently treated as empty", async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, "credentials.json"), "{ not json", "utf8");
    const store = makeStore(dir);
    await assert.rejects(store.read(), (e: unknown) => e instanceof CredentialDataError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("needsRefresh: only within the 3-minute window", () => {
  const now = 1_700_000_000_000;
  const base = { clientId: "x", scopes: [] as readonly string[], expiresAt: now };
  assert.equal(needsRefresh({ ...base, expiresAt: now + 4 * 60_000 }, now), false, "4 min out → not yet");
  assert.equal(needsRefresh({ ...base, expiresAt: now + 3 * 60_000 }, now), true, "exactly 3 min → refresh");
  assert.equal(needsRefresh({ ...base, expiresAt: now + 60_000 }, now), true, "within window → refresh");
  assert.equal(needsRefresh({ ...base, expiresAt: now }, now), true, "expired → refresh");
  // earliest_refresh_at gate: a future earliest blocks refresh even inside the window.
  assert.equal(needsRefresh({ ...base, expiresAt: now + 60_000, earliestRefreshAt: now + 10_000 }, now), false);
  assert.equal(needsRefresh({ ...base, expiresAt: now + 60_000, earliestRefreshAt: now - 1 }, now), true);

  assert.equal(needsRefresh({ ...base, expiresAt: now - 1, earliestRefreshAt: now + 10_000 }, now), true);
});

test("fromToken rejects negative/non-integer expires_in and missing direct scope", () => {
  assert.throws(
    () => ChatGptCredential.fromToken({ access_token: "a", refresh_token: "r", expires_in: 0, scope: "chatgpt.tokens.use.direct" }, "c"),
    (e: Error) => e.message.includes("expires_in"),
  );
  assert.throws(
    () => ChatGptCredential.fromToken({ access_token: "a", refresh_token: "r", expires_in: "3600", scope: "chatgpt.tokens.use.direct" }, "c"),
    (e: Error) => e.message.includes("expires_in"),
  );
  assert.throws(
    () => ChatGptCredential.fromToken({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid" }, "c"),
    (e: Error) => e.message.includes("chatgpt.tokens.use.direct"),
  );
});
