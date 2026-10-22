import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatGptAuth, ChatGptCredential, CredentialStore, runAuthCommand, StringTextWriter } from "@di/coding-agent";
import { mockLockProvider, noopAcl } from "../auth/test-doubles.ts";

async function tempStore(): Promise<{ directory: string; store: CredentialStore }> {
  const directory = await mkdtemp(join(tmpdir(), "di-auth-cli-"));
  return { directory, store: new CredentialStore({ lock: mockLockProvider(), acl: noopAcl, directory }) };
}

function authDouble(overrides: Partial<Pick<ChatGptAuth, "signIn" | "status" | "signOut" | "listModels">> = {}) {
  const calls: unknown[][] = [];
  const auth = {
    signIn: async (...args: unknown[]) => { calls.push(["signIn", ...args]); },
    status: async () => ({ signedIn: false, planEnabled: false }),
    signOut: async () => { calls.push(["signOut"]); return true; },
    listModels: async () => { calls.push(["listModels"]); return ["gpt-synthetic-a", "gpt-synthetic-b"]; },
    ...overrides,
  } as unknown as ChatGptAuth;
  return { auth, calls };
}

async function invoke(args: string[], store: CredentialStore, auth: ChatGptAuth) {
  const stdout = new StringTextWriter();
  const stderr = new StringTextWriter();
  const code = await runAuthCommand(args, stdout, stderr, store, auth);
  return { code, stdout, stderr };
}

test("auth command rejects invalid service, command, and flags without side effects", async () => {
  const { directory, store } = await tempStore();
  try {
    const { auth, calls } = authDouble();
    for (const args of [["auth", "else"], ["auth", "chatgpt"], ["auth", "chatgpt", "signup"], ["auth", "chatgpt", "login", "--bogus"]]) {
      const result = await invoke(args, store, auth);
      assert.equal(result.code, 1);
      assert.equal(result.stdout.text(), "");
      assert.notEqual(result.stderr.text(), "");
    }
    assert.deepEqual(calls, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("status reads isolated synthetic credentials and never needs a network call", async () => {
  const { directory, store } = await tempStore();
  try {
    await store.update((data) => { data.credential = new ChatGptCredential({
      clientId: "synthetic-client", accessToken: "synthetic-access", scopes: ["chatgpt.tokens.use.direct"], expiresAt: Date.now() + 60_000,
    }); });
    const auth = new ChatGptAuth(store);
    const result = await invoke(["auth", "chatgpt", "status"], store, auth);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.text(), "ChatGPT: signed_in=True plan=True client_id=synthetic-client\n");
    assert.equal(result.stderr.text(), "");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("login, logout, and models dispatch to the authenticated client", async () => {
  const { directory, store } = await tempStore();
  try {
    const { auth, calls } = authDouble();
    const login = await invoke(["auth", "chatgpt", "login", "--new", "--consent"], store, auth);
    assert.equal(login.code, 0);
    assert.equal(login.stdout.text(), "Continue with ChatGPT — complete authorization in your browser (5 minute timeout).\nChatGPT connected. Run di auth chatgpt models to list models.\n");
    assert.deepEqual(calls[0], ["signIn", ChatGptAuth.openSystemBrowser, true, true]);

    const logout = await invoke(["auth", "chatgpt", "logout"], store, auth);
    assert.equal(logout.code, 0);
    assert.equal(logout.stdout.text(), "Signed out of ChatGPT.\n");

    const models = await invoke(["auth", "chatgpt", "models"], store, auth);
    assert.equal(models.code, 0);
    assert.equal(models.stdout.text(), "chatgpt/gpt-synthetic-a  gpt-synthetic-a\nchatgpt/gpt-synthetic-b  gpt-synthetic-b\n");
    assert.equal(calls.some((call) => call[0] === "signOut"), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("auth operations surface lock-unavailable without attempting an unlocked transaction", async () => {
  const { directory } = await tempStore();
  const store = new CredentialStore({ lock: { acquire: async () => { throw Object.assign(new Error("synthetic lock failure"), { code: "lock-unavailable" }); } }, acl: noopAcl, directory });
  try {
    const auth = new ChatGptAuth(store);
    const result = await invoke(["auth", "chatgpt", "login"], store, auth);
    assert.equal(result.code, 1);
    assert.match(result.stderr.text(), /credential lock could not be acquired/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
