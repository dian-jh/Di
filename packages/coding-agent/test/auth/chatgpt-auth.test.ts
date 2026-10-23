import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ChatGptAuth,
  ChatGptAuthError,
  ChatGptCredential,
  CredentialStore,
  createAclAdapter,
  type FetchLike,
} from "@di/coding-agent";
import { mockLockProvider, noopAcl } from "./test-doubles.ts";

/**
 *
 * OAuth PKCE on a loopback 127.0.0.1 random port with a time-limited callback:
 * callback path + random `state` + authorization code + issued client ID + PKCE
 * verifier/challenge + required token fields + positive expires_in +
 * `chatgpt.tokens.use.direct` scope are all validated. Invalid NEW responses must
 * NOT overwrite a valid old credential. The ID token is saved only as an
 * authorization hint (opaque) — never decoded into claimed identity.
 *
 * All endpoints are synthetic (a fake fetch) and the loopback callback is real
 * (127.0.0.1 random port). The credential store uses the MOCKED lock — the real
 * OS-advisory-lock adapter stays out of scope (fail-closed default).
 */

const base64Url = (bytes: Buffer): string => bytes.toString("base64url");
const sha256 = (text: string): Buffer => createHash("sha256").update(text, "ascii").digest();

function jsonResponse(value: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface HttpBehavior {
  invalidField?: string;
  invalidRefreshField?: string;
  grantPlan?: boolean;
  refreshError?: string;
  codeFailuresRemaining?: number;
  readonly responseDelayMs?: number;
}

interface HttpRecords {
  grants: Array<Record<string, string>>;
  lastGrant?: Record<string, string>;
  refreshCount: number;
  revocation?: Record<string, string>;
  requests: Array<{ url: string; body?: string }>;
}

function fakeHttp(behavior: HttpBehavior = {}): { http: FetchLike; records: HttpRecords } {
  const records: HttpRecords = { grants: [], refreshCount: 0, requests: [] };
  const state = { codeFailuresRemaining: behavior.codeFailuresRemaining ?? 0 };
  const http: FetchLike = async (url, init) => {
    const u = new URL(url);
    const body = typeof init?.body === "string" ? init.body : undefined;
    records.requests.push({ url: u.pathname, body });
    if (u.pathname === "/.well-known/openid-configuration") {
      return jsonResponse({
        issuer: "https://auth.openai.com",
        authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
        token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
        jwks_uri: "https://auth.openai.com/jwks",
        revocation_endpoint: "https://auth.openai.com/revoke",
      });
    }
    if (u.pathname === "/revoke") {
      records.revocation = Object.fromEntries(new URLSearchParams(body ?? ""));
      return jsonResponse({});
    }
    if (u.pathname === "/api/accounts/oauth/token") {
      const grant = Object.fromEntries(new URLSearchParams(body ?? ""));
      records.grants.push(grant);
      records.lastGrant = grant;
      const refresh = grant.grant_type === "refresh_token";
      if (!refresh && state.codeFailuresRemaining > 0) {
        state.codeFailuresRemaining--;
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      if (refresh) {
        records.refreshCount++;
        if (behavior.responseDelayMs) await new Promise((r) => setTimeout(r, behavior.responseDelayMs));
        if (behavior.refreshError !== undefined) {
          const status = behavior.refreshError === "server_error" ? 503 : 400;
          return jsonResponse({ error: behavior.refreshError }, status);
        }
      }
      const token: Record<string, unknown> = {
        access_token: refresh ? "access-rotated" : "access-initial",
        refresh_token: refresh ? "refresh-rotated" : "refresh-initial",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email offline_access resource.invoke" + (behavior.grantPlan ?? true ? " chatgpt.tokens.use.direct" : ""),
        id_token: "opaque-id-token",
      };
      if (behavior.invalidField !== undefined) token[behavior.invalidField] = behavior.invalidField === "expires_in" ? 0 : "";
      if (refresh && behavior.invalidRefreshField !== undefined) token[behavior.invalidRefreshField] = behavior.invalidRefreshField === "expires_in" ? 0 : "";
      return jsonResponse(token);
    }
    throw new Error("Unexpected HTTP request: " + url);
  };
  return { http, records };
}

function parseQuery(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(search)) out[k] = v;
  return out;
}

interface Fixture {
  readonly dir: string;
  readonly store: CredentialStore;
  readonly auth: ChatGptAuth;
  readonly http: FetchLike;
  readonly records: HttpRecords;
  readonly authorizations: Array<Record<string, string>>;
  readonly invalidStateRejected: () => boolean;
  readonly browser: (uri: URL) => Promise<void>;
  readonly expire: () => Promise<void>;
}

interface BrowserOptions {
  deny?: boolean;
  sendInvalidState?: boolean;
  callbackClientId?: string;
}

function createFixture(behavior: HttpBehavior = {}, browserOpts: BrowserOptions = {}): Fixture {
  const dir = mkdtempSync0();
  const lock = mockLockProvider();
  const store = new CredentialStore({ lock, acl: createAclAdapter(), directory: dir });
  const { http, records } = fakeHttp(behavior);
  const auth = new ChatGptAuth(store, { http });
  const authorizations: Array<Record<string, string>> = [];
  const state = { invalidStateRejected: false };

  const browser = async (uri: URL) => {
    const authorization = parseQuery(uri.search);
    authorizations.push(authorization);
    const redirect = authorization["redirect_uri"]!;
    const callback =
      `${redirect}?state=${authorization["state"]}` +
      (browserOpts.deny
        ? "&error=access_denied"
        : `&code=code_test&client_id=${browserOpts.callbackClientId ?? "oaiapp_test"}`);
    // authorize races this promise with its live callback queue. Returning the
    // navigation promise also reports fetch failures and avoids detached work
    // continuing after fixture cleanup or the next sign-in.
    if (browserOpts.sendInvalidState) {
      const invalid = await fetch(`${redirect}?state=wrong&code=bad`);
      state.invalidStateRejected = invalid.status === 400;
      await invalid.text();
    }
    const response = await fetch(callback);
    await response.text();
  };

  return {
    dir,
    store,
    auth,
    http,
    records,
    authorizations,
    invalidStateRejected: () => state.invalidStateRejected,
    browser,
    expire: async () => {
      await store.update((data) => {
        if (data.credential) data.credential.expiresAt = Date.now() - 1000;
      });
    },
  };
}

function mkdtempSync0(): string {
  return mkdtempSync(join(tmpdir(), "di-p8b-auth-"));
}

test("registration: dynamic client, agent hint, host id and PKCE challenge are validated", async () => {
  const f = createFixture();
  try {
    await f.auth.signIn(f.browser);
    assert.equal((await f.auth.status()).planEnabled, true);
    const authorization = f.authorizations[0]!;
    assert.equal(authorization["client_id"], "dynamic_agent_client");
    assert.equal(authorization["agent_name_hint"], "Di");
    assert.equal(authorization["response_type"], "code");
    assert.equal(authorization["code_challenge_method"], "S256");
    assert.equal(authorization["resource"], "https://api.openai.com/v1");
    const grant = f.records.lastGrant!;
    assert.equal(grant["client_id"], "oaiapp_test", "the issued client id must be used for the token exchange");
    assert.equal(grant["redirect_uri"], authorization["redirect_uri"]);
    assert.equal(grant["code_verifier"], f.records.grants[0]!["code_verifier"]);
    assert.equal(
      authorization["code_challenge"],
      base64Url(sha256(f.records.grants[0]!["code_verifier"]!)),
      "S256 challenge must match the verifier",
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("registration reuses host and client and validates the PKCE hand-off", async () => {
  const f = createFixture();
  try {
    await f.auth.signIn(f.browser);
    const host = f.authorizations[0]!["ext_agent_host_id"];
    await f.auth.signIn(f.browser);
    const second = f.authorizations[1]!;
    assert.equal(second["ext_agent_host_id"], host, "host id must be reused across sign-ins");
    assert.equal(second["client_id"], "oaiapp_test", "second sign-in reuses the issued client id");
    assert.ok(second["id_token_hint"] !== undefined, "opaque id token hint is carried to the authorize URL");
    assert.ok(!("agent_name_hint" in second), "registered client must not send the agent name hint");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("consumed code retries with the issued client", async () => {
  const f = createFixture({ codeFailuresRemaining: 1 });
  try {
    await f.auth.signIn(f.browser);
    assert.equal(f.records.lastGrant!["client_id"], "oaiapp_test");
    assert.equal(f.authorizations[0]!["client_id"], "dynamic_agent_client");
    const second = f.authorizations[1]!;
    assert.equal(second["client_id"], "oaiapp_test", "retry authorizes with the issued client id");
    assert.ok(!("agent_name_hint" in second));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("invalid state callback is rejected with 400 before the valid callback completes", async () => {
  const f = createFixture({}, { sendInvalidState: true });
  try {
    await f.auth.signIn(f.browser);
    assert.equal(f.invalidStateRejected(), true);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("declined authorization does not exchange a code", async () => {
  const f = createFixture({}, { deny: true });
  try {
    await assert.rejects(f.auth.signIn(f.browser), (e: unknown) => e instanceof ChatGptAuthError && e.code === "auth-failed");
    assert.equal(f.records.lastGrant, undefined, "a declined callback must never exchange a code");
    assert.equal((await f.auth.status()).signedIn, false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

for (const clientId of ["", "dynamic_agent_client"]) {
  test(`missing issued client (${JSON.stringify(clientId)}) is rejected without exchanging`, async () => {
    const f = createFixture({}, { callbackClientId: clientId });
    try {
      await assert.rejects(f.auth.signIn(f.browser), (e: unknown) => e instanceof ChatGptAuthError && e.code === "invalid-data");
      assert.equal(f.records.lastGrant, undefined);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}

test("a changed client preserves the old connection", async () => {
  const f = createFixture({});
  try {
    await f.auth.signIn(f.browser);
    assert.equal(f.authorizations[0]!["client_id"], "dynamic_agent_client");
    // Second sign-in: the authorize URL carries the issued client, but the callback
    // presents a DIFFERENT client id → rejected, and the saved credential is untouched.
    const lockedStore = f.store;
    await assert.rejects(
      f.auth.signIn(async (uri: URL) => {
        const authorization = parseQuery(uri.search);
        const redirect = authorization["redirect_uri"]!;
        await fetch(`${redirect}?state=${authorization["state"]}&code=code_test&client_id=oaiapp_different`);
      }),
      (e: unknown) => e instanceof ChatGptAuthError && e.code === "invalid-data",
    );
    const status = await lockedStore.read();
    assert.equal(status.credential?.clientId, "oaiapp_test", "old credential must be preserved on a bad callback");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

for (const field of ["access_token", "refresh_token", "scope", "id_token", "expires_in"]) {
  test(`token contract rejects invalid ${field}`, async () => {
    const f = createFixture({ invalidField: field });
    try {
      await assert.rejects(f.auth.signIn(f.browser), (e: unknown) => e instanceof ChatGptAuthError && e.code === "invalid-data");
      assert.equal((await f.auth.status()).signedIn, false, "an invalid new response must not sign the user in");
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
}

test("token contract requires the plan/direct scope", async () => {
  const f = createFixture({ grantPlan: false });
  try {
    await assert.rejects(f.auth.signIn(f.browser), (e: unknown) => e instanceof ChatGptAuthError && e.code === "invalid-data");
    assert.equal(await f.auth.accessToken(), null, "no direct scope → no usable access token");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("check is local and never refreshes", async () => {
  const f = createFixture();
  try {
    assert.equal(await f.auth.check(), false);
    await f.auth.signIn(f.browser);
    await f.expire();
    assert.equal(await f.auth.check(), true, "an expired token with a refresh token still checks locally");
    assert.equal(f.records.refreshCount, 0, "check must not trigger a network refresh");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("a fresh credential is returned without refreshing (only inside the 3-minute window)", async () => {
  const f = createFixture();
  try {
    await f.auth.signIn(f.browser);
    const token = await f.auth.accessToken();
    assert.equal(token, "access-initial");
    assert.equal(f.records.refreshCount, 0, "a token >3min from expiry must not be refreshed");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("model discovery uses a refreshed-or-current synthetic bearer token and visibility filter", async () => {
  const f = createFixture();
  try {
    await f.store.update((data) => {
      data.credential = new ChatGptCredential({
        clientId: "synthetic-client", accessToken: "synthetic-catalog-access", scopes: ["chatgpt.tokens.use.direct"], expiresAt: Date.now() + 3_600_000,
      });
    });
    let url = "";
    let authorization = "";
    const auth = new ChatGptAuth(f.store, { http: async (requestUrl, init) => {
      url = requestUrl;
      authorization = init?.headers?.authorization ?? "";
      return jsonResponse({ data: [{ id: "gpt-synthetic" }, { id: "gpt-synthetic-2" }] });
    } });
    assert.deepEqual(await auth.listModels(), ["gpt-synthetic", "gpt-synthetic-2"]);
    assert.equal(url, "https://api.openai.com/v1/models?visibility=list");
    assert.equal(authorization, "Bearer synthetic-catalog-access");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("refresh rotates exactly once across concurrent instances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "di-p8b-rot-"));
  try {
    const lock = mockLockProvider();
    const http1 = fakeHttp({ responseDelayMs: 30 });
    const http2 = fakeHttp({ responseDelayMs: 30 });
    const store1 = new CredentialStore({ lock, acl: noopAcl, directory: dir });
    const store2 = new CredentialStore({ lock, acl: noopAcl, directory: dir });
    const auth1 = new ChatGptAuth(store1, { http: http1.http });
    const auth2 = new ChatGptAuth(store2, { http: http2.http });

    // sign in (writes a fresh credential), then expire it.
    await auth1.signIn(async (uri: URL) => {
      const authorization = parseQuery(uri.search);
      await fetch(`${authorization["redirect_uri"]}?state=${authorization["state"]}&code=code_test&client_id=oaiapp_test`);
    });
    await store1.update((data) => {
      if (data.credential) data.credential.expiresAt = Date.now() - 1000;
    });

    const [t1, t2] = await Promise.all([auth1.accessToken(), auth2.accessToken()]);
    assert.equal(t1, "access-rotated");
    assert.equal(t2, "access-rotated");
    assert.equal(http1.records.refreshCount + http2.records.refreshCount, 1, "exactly one refresh consumes the one-time refresh token");
    const grant = http1.records.lastGrant ?? http2.records.lastGrant!;
    assert.equal(grant["client_id"], "oaiapp_test");
    assert.equal(grant["resource"], "https://api.openai.com/v1");
    assert.ok(!("scope" in grant), "the refresh grant must not re-send the scope");
    const persisted = (await store1.read()).credential!;
    assert.equal(persisted.refreshToken, "refresh-rotated", "the rotated refresh token must be persisted");
    assert.equal(persisted.accessToken, "access-rotated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminal refresh errors clear only the tokens; transient errors retain and throw", async () => {
  for (const [code, retained] of [
    ["invalid_grant", false],
    ["refresh_token_reused", false],
    ["server_error", true],
  ] as Array<[string, boolean]>) {
    const f = createFixture({ refreshError: code });
    try {
      await f.auth.signIn(f.browser);
      await f.expire();
      if (retained) {
        await assert.rejects(f.auth.accessToken(), (e: unknown) => e instanceof ChatGptAuthError && e.code === code);
      } else {
        assert.equal(await f.auth.accessToken(), null);
      }
      const status = await f.auth.status();
      assert.equal(status.signedIn, retained, `${code}: signed-in retained only for transient errors`);
      assert.equal(status.clientId, "oaiapp_test", "registration survives a terminal credential clear");
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  }
});

test("a bad refresh response must NOT overwrite a valid old credential", async () => {
  const f = createFixture({ invalidRefreshField: "access_token" });
  try {
    await f.auth.signIn(f.browser);
    await f.expire();
    await assert.rejects(f.auth.accessToken(), (e: unknown) => e instanceof ChatGptAuthError && e.code === "invalid-data");
    const persisted = (await f.store.read()).credential!;
    assert.equal(persisted.accessToken, "access-initial", "the old valid access token must be preserved");
    assert.equal(persisted.refreshToken, "refresh-initial");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("logout revokes the refresh token and retains the registration", async () => {
  const f = createFixture();
  try {
    await f.auth.signIn(f.browser);
    assert.equal(await f.auth.signOut(), true);
    assert.equal(f.records.revocation?.["token"], "refresh-initial");
    assert.equal(f.records.revocation?.["token_type_hint"], "refresh_token");
    assert.equal((await f.auth.status()).signedIn, false);
    await f.auth.signIn(f.browser);
    const second = f.authorizations[1]!;
    assert.equal(second["client_id"], "oaiapp_test");
    assert.ok(!("id_token_hint" in second), "after logout the id token hint is not sent again");
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("sensitive OAuth values are never logged (token/code/verifier/refresh body)", async () => {
  const f = createFixture({});
  const lines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await f.auth.signIn(f.browser);
    await f.expire();
    await f.auth.accessToken();
    await f.auth.signOut();
  } finally {
    console.log = origLog;
    console.error = origError;
    await rm(f.dir, { recursive: true, force: true });
  }
  const joined = lines.join("\n");
  for (const secret of [
    "access-initial",
    "refresh-initial",
    "access-rotated",
    "refresh-rotated",
    "opaque-id-token",
    "code_test",
    f.records.grants[0]?.["code_verifier"] ?? "code_verifier",
    "invalid_grant",
  ]) {
    assert.ok(!joined.includes(secret), `sensitive value must never be logged: ${secret}`);
  }
});

test("ID token is saved only as an opaque hint, never decoded or claimed as identity", async () => {
  const f = createFixture();
  try {
    await f.auth.signIn(f.browser);
    const credential = (await f.store.read()).credential!;
    assert.equal(credential.idToken, "opaque-id-token");
    assert.ok(
      credential.idToken === "opaque-id-token",
      "the id token is stored verbatim as an authorization hint",
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("fromToken sets expiresAt from a positive expires_in and keeps the previous id token/scope on a refresh", () => {
  const prev = ChatGptCredential.fromToken(
    { access_token: "a1", refresh_token: "r1", expires_in: 3600, scope: "openid chatgpt.tokens.use.direct", id_token: "prev-id" },
    "c1",
  );
  const now = Date.now();
  assert.ok(prev.expiresAt > now && prev.expiresAt <= now + 3600 * 1000 + 1000);
  const rotated = ChatGptCredential.fromToken(
    { access_token: "a2", refresh_token: "r2", expires_in: 3600 },
    "c1",
    prev,
  );
  assert.equal(rotated.idToken, "prev-id", "missing id_token falls back to the previous hint");
  assert.ok(rotated.scopes.includes("chatgpt.tokens.use.direct"), "missing scope falls back to the previous scopes");
});
