import test from "node:test";
import assert from "node:assert/strict";
import { CliApp, nullTextReader, StringTextWriter } from "@di/coding-agent";

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
