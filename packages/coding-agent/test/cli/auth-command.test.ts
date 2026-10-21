import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ChatGptCredential,
  CliApp,
  CredentialStore,
  nullTextReader,
  runAuthCommand,
  StringTextWriter,
} from "@di/coding-agent";
import { mockLockProvider, noopAcl } from "../auth/test-doubles.ts";

/**
 * P6.3b card — `di auth chatgpt ...` command resolution (the argument-validation
 * half of C# `Di.Cli/ChatGptAuthCommand.cs` at baseline 09f4e08). The actual OAuth
 * sign-in / status / logout / models flows are P8b and BLOCKED on the unresolved
 * Windows-ACL/lock credential-store platform gate: every valid subcommand FAILS
 * CLOSED with an honest "not yet available" message on stderr and exit 1 — no
 * fake credentials, no fake OAuth flow. Invalid syntax mirrors the C# usage and
 * argument errors exactly.
 */

function run(...args: string[]) {
  const stdout = new StringTextWriter();
  const stderr = new StringTextWriter();
  const app = new CliApp(() => {
    throw new Error("auth 路径不应构建宿主");
  });
  return {
    codePromise: app.runAsync(args, nullTextReader, stdout, stderr, true, true),
    stdout,
    stderr,
  };
}

test("Auth_UnknownService_UsageToStderr_ExitsOne", async () => {
  const { codePromise, stdout, stderr } = run("auth", "foo");

  const code = await codePromise;
  assert.equal(code, 1);
  assert.ok(stderr.text().includes("Usage: di auth chatgpt login [--new] [--consent] | status | logout | models"));
  assert.equal(stdout.text(), "");
});

test("Auth_ChatgptMissingSubcommand_UsageToStderr_ExitsOne", async () => {
  const { codePromise, stdout, stderr } = run("auth", "chatgpt");

  const code = await codePromise;
  assert.equal(code, 1);
  assert.ok(stderr.text().includes("Usage: di auth chatgpt login [--new] [--consent] | status | logout | models"));
  assert.equal(stdout.text(), "");
});

test("Auth_ChatgptTooManyArgs_UsageToStderr_ExitsOne", async () => {
  const { codePromise, stdout, stderr } = run("auth", "chatgpt", "login", "--new", "--consent", "--extra");

  const code = await codePromise;
  assert.equal(code, 1);
  assert.ok(stderr.text().includes("Usage: di auth chatgpt login [--new] [--consent] | status | logout | models"));
  assert.equal(stdout.text(), "");
});

test("Auth_ChatgptUnknownSubcommand_ErrorToStderr_ExitsOne", async () => {
  const { codePromise, stdout, stderr } = run("auth", "chatgpt", "signup");

  const code = await codePromise;
  assert.equal(code, 1);
  assert.ok(stderr.text().includes("Unknown ChatGPT auth command or arguments."));
  assert.equal(stdout.text(), "");
});

test("Auth_ChatgptLogin_InvalidExtraFlag_ErrorToStderr_ExitsOne", async () => {
  // C# throws ArgumentException("Use --new to register another ChatGPT connection.")
  // for any flag other than --new/--consent.
  const { codePromise, stdout, stderr } = run("auth", "chatgpt", "login", "--bogus");

  const code = await codePromise;
  assert.equal(code, 1);
  assert.ok(stderr.text().includes("Use --new to register another ChatGPT connection."));
  assert.equal(stdout.text(), "");
});

test("Auth_ChatgptStatus_WithExtraArg_ErrorToStderr_ExitsOne", async () => {
  const { codePromise, stdout, stderr } = run("auth", "chatgpt", "status", "extra");

  const code = await codePromise;
  assert.equal(code, 1);
  assert.ok(stderr.text().includes("Unknown ChatGPT auth command or arguments."));
  assert.equal(stdout.text(), "");
});

// ---- valid subcommands: fail closed, honest "not yet available" ----

test("Auth_ChatgptLogin_NotYetAvailable_ExitsOne", async () => {
  const { codePromise, stdout, stderr } = run("auth", "chatgpt", "login");

  const code = await codePromise;
  assert.equal(code, 1);
  assert.ok(stderr.text().includes("尚未在 TypeScript 后端"));
  assert.ok(stderr.text().includes("chatgpt"));
  assert.equal(stdout.text(), "");
});

test("Auth_ChatgptLogin_NewAndConsent_NotYetAvailable_ExitsOne", async () => {
  const { codePromise, stdout, stderr } = run("auth", "chatgpt", "login", "--new", "--consent");

  const code = await codePromise;
  assert.equal(code, 1);
  assert.ok(stderr.text().includes("尚未在 TypeScript 后端"));
  assert.equal(stdout.text(), "");
});

test("Auth_ChatgptStatus_NotYetAvailable_ExitsOne", async () => {
  const { codePromise, stdout, stderr } = run("auth", "chatgpt", "status");

  const code = await codePromise;
  assert.equal(code, 1);
  assert.ok(stderr.text().includes("尚未在 TypeScript 后端"));
  assert.equal(stdout.text(), "");
});

test("Auth_ChatgptModels_NotYetAvailable_ExitsOne", async () => {
  const { codePromise, stdout, stderr } = run("auth", "chatgpt", "models");

  const code = await codePromise;
  assert.equal(code, 1);
  assert.ok(stderr.text().includes("尚未在 TypeScript 后端"));
  assert.equal(stdout.text(), "");
});

test("Auth_ChatgptLogout_NotYetAvailable_ExitsOne", async () => {
  const { codePromise, stdout, stderr } = run("auth", "chatgpt", "logout");

  const code = await codePromise;
  assert.equal(code, 1);
  assert.ok(stderr.text().includes("尚未在 TypeScript 后端"));
  assert.equal(stdout.text(), "");
});

// ---- P8b: valid subcommands attempt the store through the fail-closed lock seam ----

function workingStore(dir: string) {
  return new CredentialStore({ lock: mockLockProvider(), acl: noopAcl, directory: dir });
}

test("Auth_ChatgptStatus_WithStoreAvailable_PrintsRealStatusLine_ExitsZero", async () => {
  // A store backed by a working (mock) lock makes `status` a real local read —
  // never faked: no credentials yet, so the C#-mirrored line says signed_in=False.
  const dir = mkdtempSync(join(tmpdir(), "di-p8b-authcmd-"));
  try {
    const stdout = new StringTextWriter();
    const stderr = new StringTextWriter();
    const code = await runAuthCommand(["auth", "chatgpt", "status"], stdout, stderr, workingStore(dir));
    assert.equal(code, 0);
    assert.equal(stdout.text(), "ChatGPT: signed_in=False plan=False client_id=none\n");
    assert.equal(stderr.text(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Auth_ChatgptStatus_WithStoredCredential_PrintsRealStatusLine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "di-p8b-authcmd-"));
  try {
    const store = workingStore(dir);
    await store.update((data) => {
      data.credential = new ChatGptCredential({
        clientId: "oaiapp_test",
        accessToken: "access-initial",
        scopes: ["chatgpt.tokens.use.direct"],
        expiresAt: Date.now() + 3_600_000,
      });
    });
    const stdout = new StringTextWriter();
    const stderr = new StringTextWriter();
    const code = await runAuthCommand(["auth", "chatgpt", "status"], stdout, stderr, store);
    assert.equal(code, 0);
    assert.equal(stdout.text(), "ChatGPT: signed_in=True plan=True client_id=oaiapp_test\n");
    assert.equal(stderr.text(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Auth_ChatgptLogin_AttemptsStore_ThenFailsClosedHonestly", async () => {
  // login really attempts the store (acquires the lock through the seam); with the
  // real OAuth flow still unwired it fails closed with the honest message and
  // exit 1 — never faking a credential or a sign-in.
  const dir = mkdtempSync(join(tmpdir(), "di-p8b-authcmd-"));
  try {
    const lock = mockLockProvider();
    const stdout = new StringTextWriter();
    const stderr = new StringTextWriter();
    const store = new CredentialStore({ lock, acl: noopAcl, directory: dir });
    const code = await runAuthCommand(["auth", "chatgpt", "login"], stdout, stderr, store);
    assert.equal(code, 1);
    assert.ok(stderr.text().includes("尚未在 TypeScript 后端"));
    assert.equal(stdout.text(), "");
    assert.ok(lock.acquireCalls > 0, "login must attempt the store through the lock seam");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Auth_ChatgptLogout_WithFailClosedStore_ExitsOne", async () => {
  // Default (fail-closed) store: logout surfaces the honest message, exit 1.
  const stdout = new StringTextWriter();
  const stderr = new StringTextWriter();
  const code = await runAuthCommand(["auth", "chatgpt", "logout"], stdout, stderr);
  assert.equal(code, 1);
  assert.ok(stderr.text().includes("尚未在 TypeScript 后端"));
  assert.equal(stdout.text(), "");
});
