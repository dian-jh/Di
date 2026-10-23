import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AclError, createAclAdapter, CredentialStore } from "@di/coding-agent";
import { mockLockProvider, noopAcl } from "./test-doubles.ts";

/**
 * Windows: set and read back the current-user-only DACL via `icacls` subprocess
 * (Node `stat.mode` on NTFS is not a valid verification channel and commonly
 * so it is NEVER used as the verification channel). POSIX: chmod 0700 dir /
 * 0600 file with stat.mode readback (valid on real POSIX). Any failure to apply
 * or verify → AclError → the store refuses the token write (fail closed, old
 * file preserved) — the contract forbids "log a warning and keep claiming safety".
 */

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "di-p8b-acl-"));
}

test("POSIX secureDirectory applies 0700 and verifies via mode readback", async () => {
  const dir = await tempDir();
  try {
    const chmods: Array<[string, number]> = [];
    const adapter = createAclAdapter({
      platform: "linux",
      chmod: async (path, mode) => {
        chmods.push([path, mode]);
      },
      stat: async (path) => ({ mode: 0o100700 }), // 0700 with file-type bits
    });
    await adapter.secureDirectory(dir);
    assert.deepEqual(chmods, [[dir, 0o700]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POSIX secureFile applies 0600 and verifies via mode readback", async () => {
  const dir = await tempDir();
  try {
    const chmods: Array<[string, number]> = [];
    const adapter = createAclAdapter({
      platform: "linux",
      chmod: async (path, mode) => {
        chmods.push([path, mode]);
      },
      stat: async () => ({ mode: 0o100600 }), // 0600 with file-type bits
    });
    const file = join(dir, "credentials.json");
    await adapter.secureFile(file);
    assert.deepEqual(chmods, [[file, 0o600]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POSIX mode readback mismatch fails closed with AclError", async () => {
  const dir = await tempDir();
  try {
    const adapter = createAclAdapter({
      platform: "linux",
      chmod: async () => {},
      stat: async () => ({ mode: 0o100666 }), // NTFS-style: chmod was a no-op
    });
    await assert.rejects(
      adapter.secureFile(join(dir, "credentials.json")),
      (e: unknown) => e instanceof AclError && e.code === "acl-failed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("win32 secureFile grants the current-user-only DACL via icacls and verifies by readback", async () => {
  // Exercise real icacls on Windows. Skipped on POSIX.
  if (process.platform !== "win32") return;
  const dir = await tempDir();
  try {
    const { writeFile } = await import("node:fs/promises");
    const file = join(dir, "creds.json");
    await writeFile(file, "x", "utf8");
    const adapter = createAclAdapter();
    await adapter.secureFile(file);
    const { execFile } = await import("node:child_process");
    const { stdout } = await new Promise<{ stdout: Buffer }>((resolve, reject) =>
      execFile("icacls", [file], { windowsHide: true }, (error, so) => (error ? reject(error) : resolve({ stdout: so as unknown as Buffer }))),
    );
    const text = typeof stdout === "string" ? stdout : new TextDecoder("gbk").decode(stdout);
    assert.ok(text.includes("(F)"), `readback must show the owner full-control ACE:\n${text}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("win32 secureDirectory grants an inheriting current-user-only DACL and verifies by readback", async () => {
  if (process.platform !== "win32") return;
  const dir = await tempDir();
  try {
    const adapter = createAclAdapter();
    await adapter.secureDirectory(dir);
    const { execFile } = await import("node:child_process");
    const { stdout } = await new Promise<{ stdout: Buffer }>((resolve, reject) =>
      execFile("icacls", [dir], { windowsHide: true }, (error, so) => (error ? reject(error) : resolve({ stdout: so as unknown as Buffer }))),
    );
    const text = typeof stdout === "string" ? stdout : new TextDecoder("gbk").decode(stdout);
    assert.ok(text.includes("(OI)(CI)"), `readback must show inheriting container ACEs:\n${text}`);
    assert.ok(text.includes("(F)"), `readback must show full control:\n${text}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("icacls subprocess failure surfaces as AclError (fail closed)", async () => {
  const dir = await tempDir();
  try {
    const adapter = createAclAdapter({
      platform: "win32",
      winUser: "nobody-xyz",
      run: async () => {
        throw new Error("icacls exited 5: access denied");
      },
    });
    await assert.rejects(
      adapter.secureFile(join(dir, "credentials.json")),
      (e: unknown) => e instanceof AclError && e.code === "acl-failed" && String(e.message).includes("icacls"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("store refuses the token write when the ACL adapter fails (old file preserved)", async () => {
  const dir = await tempDir();
  try {
    const lock = mockLockProvider();
    const store = new CredentialStore({ lock, acl: noopAcl, directory: dir });
    await store.update((data) => {
      data.hostId = "urn:uuid:original";
    });
    const { readFile } = await import("node:fs/promises");
    const path = join(dir, "credentials.json");
    const before = await readFile(path, "utf8");

    const failingStore = new CredentialStore({
      lock: mockLockProvider(),
      acl: {
        async secureDirectory() {},
        async secureFile() {
          throw new AclError("icacls verify failed (simulated)");
        },
      },
      directory: dir,
    });
    await assert.rejects(
      failingStore.update((data) => {
        data.hostId = "urn:uuid:overwritten";
      }),
      (e: unknown) => e instanceof AclError,
    );
    const after = await readFile(path, "utf8");
    assert.equal(after, before, "ACL failure must keep the old credentials file intact");
    const entries = await readdir(dir);
    assert.equal(
      entries.filter((f) => f.endsWith(".tmp")).length,
      0,
      "no orphan temp file may remain after a refused write",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
