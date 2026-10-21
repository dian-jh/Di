import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

import { ChatGptAuthError } from "./errors.ts";
import {
  CHATGPT_AGENT_NAME_HINT,
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_DIRECT_SCOPE,
  CHATGPT_DISCOVERY_URL,
  CHATGPT_DYNAMIC_CLIENT_ID,
  CHATGPT_RESOURCE,
  CHATGPT_SCOPES,
  CHATGPT_TOKEN_URL,
} from "./constants.ts";
import { ChatGptCredential, needsRefresh, type CredentialStore } from "./credential-store.ts";

/**
 * Token-only host-side ChatGPT OAuth client (C# `ChatGptAuth` @09f4e08).
 *
 * OAuth PKCE over a loopback `127.0.0.1` random port with a time-limited
 * callback. Validation mirrors the C# faithfully: callback path, random `state`,
 * authorization code, issued client ID, PKCE verifier/challenge, required token
 * fields, positive `expires_in` and the `chatgpt.tokens.use.direct` scope.
 * Invalid NEW responses must NOT overwrite a valid old credential (the credential
 * store transaction re-reads inside the lock and only commits validated data).
 * The ID token is saved only as an opaque authorization hint — never decoded,
 * never claimed as verified identity.
 *
 * Refresh uses the store's single `update` transaction so exactly one process can
 * consume the one-time refresh token; transient network/5xx failures keep the old
 * credential and surface a recoverable error, while terminal refresh-token
 * rejections clear the tokens (requiring re-login) but retain the registration.
 * Logout revokes the refresh token and clears tokens while keeping host/client
 * registration. `status` is a local read and never refreshes.
 *
 * `http` and `openBrowser` are injected (synthetic endpoints / no real browser in
 * tests); the callback loopback server is real (127.0.0.1 random port).
 */

/** Minimal fetch contract so tests inject synthetic endpoints without the DOM Response type. */
export interface FetchLike {
  (
    url: string,
    init?: {
      readonly method?: string;
      readonly headers?: Record<string, string>;
      readonly body?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<{
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
  }>;
}

export interface ChatGptStatus {
  readonly clientId?: string;
  readonly signedIn: boolean;
  readonly planEnabled: boolean;
}

export interface ChatGptAuthOptions {
  /** Injected HTTP client; defaults to `globalThis.fetch`. */
  readonly http?: FetchLike;
  /** Time limit for the authorization callback, in ms (C#: 5 minutes). */
  readonly authorizationTimeoutMs?: number;
  /** Time limit for a token-endpoint response, in ms. */
  readonly tokenTimeoutMs?: number;
}

/** Terminal refresh-token rejections (C# `AccessTokenAsync` catch list). */
const TERMINAL_REFRESH_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TOKEN_TIMEOUT_MS = 60_000;

interface Grant {
  readonly code: string;
  readonly clientId: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

interface CallbackItem {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
}

export class ChatGptAuth {
  readonly store: CredentialStore;
  private readonly http: FetchLike;
  private readonly authorizationTimeoutMs: number;
  private readonly tokenTimeoutMs: number;

  constructor(store: CredentialStore, options: ChatGptAuthOptions = {}) {
    this.store = store;
    this.http = options.http ?? globalFetch;
    this.authorizationTimeoutMs = options.authorizationTimeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS;
    this.tokenTimeoutMs = options.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
  }

  /** Local, never refreshes (C# `StatusAsync`). */
  async status(signal?: AbortSignal): Promise<ChatGptStatus> {
    const c = (await this.store.read(signal)).credential;
    return {
      clientId: c?.clientId,
      signedIn: c?.accessToken !== undefined,
      planEnabled: c?.scopes.includes(CHATGPT_DIRECT_SCOPE) ?? false,
    };
  }

  /** Local signed-in check for the model catalog — never refreshes (C# `CheckAsync`). */
  async check(signal?: AbortSignal): Promise<boolean> {
    const c = (await this.store.read(signal)).credential;
    return (
      c !== undefined &&
      c.scopes.includes(CHATGPT_DIRECT_SCOPE) &&
      ((c.accessToken !== undefined && c.expiresAt > Date.now()) || c.refreshToken !== undefined)
    );
  }

  /** Full OAuth PKCE sign-in (C# `SignInAsync`). `openBrowser` receives the authorize URL. */
  async signIn(
    openBrowser: (uri: URL) => Promise<void>,
    newRegistration = false,
    requestConsent = false,
    signal?: AbortSignal,
  ): Promise<void> {
    const saved = await this.store.update(async () => {}, signal);
    let clientId = newRegistration ? undefined : saved.credential?.clientId;
    let credential: ChatGptCredential | undefined;
    for (let attempt = 0; ; attempt++) {
      const grant = await this.authorize(openBrowser, saved.hostId, clientId, newRegistration ? undefined : saved.credential?.idToken, requestConsent, signal);
      clientId = grant.clientId;
      try {
        const token = await this.requestToken(
          {
            grant_type: "authorization_code",
            client_id: grant.clientId,
            code: grant.code,
            code_verifier: grant.verifier,
            redirect_uri: grant.redirectUri,
            resource: CHATGPT_RESOURCE,
          },
          signal,
        );
        tokenString(token, "id_token"); // opaque authorization hint; never decoded as identity
        credential = ChatGptCredential.fromToken(token, grant.clientId);
        break;
      } catch (error) {
        // Retry fresh PKCE using the issued client ID, without registering twice.
        if (error instanceof ChatGptAuthError && error.code === "invalid_grant" && attempt === 0) continue;
        throw error;
      }
    }
    await this.store.update((data) => {
      data.credential = credential;
    }, signal);
  }

  /** Resolve an access token, refreshing inside the store transaction when within the 3-minute window. */
  async accessToken(signal?: AbortSignal): Promise<string | null> {
    const saved = (await this.store.read(signal)).credential;
    if (saved === undefined || !saved.scopes.includes(CHATGPT_DIRECT_SCOPE)) return null;
    if (!needsRefresh(saved)) return saved.accessToken ?? null;
    const data = await this.store.update(async (state) => {
      const current = state.credential;
      if (current === undefined || !needsRefresh(current) || current.refreshToken === undefined) return;
      try {
        const token = await this.requestToken(
          {
            grant_type: "refresh_token",
            client_id: current.clientId,
            refresh_token: current.refreshToken,
            resource: CHATGPT_RESOURCE,
          },
          signal,
        );
        state.credential = ChatGptCredential.fromToken(token, current.clientId, current);
      } catch (error) {
        if (error instanceof ChatGptAuthError && TERMINAL_REFRESH_CODES.has(error.code)) {
          current.clearTokens(); // terminal: clear tokens, require re-login
        } else {
          throw error; // transient: preserve the old credential, surface a recoverable error
        }
      }
    }, signal);
    const result = data.credential;
    return result !== undefined && result.expiresAt > Date.now() && result.scopes.includes(CHATGPT_DIRECT_SCOPE)
      ? result.accessToken ?? null
      : null;
  }

  /** Revoke the refresh token, clear tokens, retain registration (C# `SignOutAsync`). */
  async signOut(signal?: AbortSignal): Promise<boolean> {
    let confirmed = true;
    await this.store.update(async (data) => {
      const c = data.credential;
      if (c === undefined) return;
      if (c.refreshToken !== undefined) {
        confirmed = false;
        try {
          const discovery = await this.getJson(CHATGPT_DISCOVERY_URL, signal);
          const endpoint = tokenString(discovery, "revocation_endpoint");
          const parsed = new URL(endpoint);
          if (parsed.protocol !== "https:" || parsed.host !== "auth.openai.com" || (parsed.port !== "" && parsed.port !== "443")) {
            throw new ChatGptAuthError("Unexpected revocation endpoint.", "invalid-data");
          }
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const response = await this.http(parsed.toString(), {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  token: c.refreshToken,
                  token_type_hint: "refresh_token",
                  client_id: c.clientId,
                }).toString(),
                signal,
              });
              if (response.ok) {
                confirmed = true;
                break;
              }
              if (response.status < 500) break;
            } catch (error) {
              // Network-level failure: retry (C# catches HttpRequestException).
              if (isAbortError(error)) throw error;
            }
            await sleep((attempt + 1) * 1000, signal);
          }
        } catch (error) {
          // Best-effort revocation: connection/timeout/cancel/invalid-data are swallowed;
          // the local clear still happens and the caller reports "not confirmed".
          if (!(error instanceof ChatGptAuthError) && !isAbortError(error)) throw error;
        }
      }
      c.clearTokens(); // retain the issued registration for the next sign-in
    });
    return confirmed;
  }

  private async authorize(
    openBrowser: (uri: URL) => Promise<void>,
    hostId: string,
    clientId: string | undefined,
    idToken: string | undefined,
    consent: boolean,
    signal?: AbortSignal,
  ): Promise<Grant> {
    const state = random();
    const verifier = random();
    const server = createServer();
    try {
      await listen(server);
      const port = (server.address() as AddressInfo).port;
      const redirect = `http://127.0.0.1:${port}/auth/callback`;
      const query = new URLSearchParams();
      query.set("client_id", clientId ?? CHATGPT_DYNAMIC_CLIENT_ID);
      query.set("ext_agent_host_id", hostId);
      query.set("response_type", "code");
      query.set("redirect_uri", redirect);
      query.set("scope", CHATGPT_SCOPES);
      query.set("resource", CHATGPT_RESOURCE);
      query.set("state", state);
      query.set("nonce", random());
      query.set("code_challenge_method", "S256");
      query.set("code_challenge", base64Url(sha256(verifier)));
      if (clientId === undefined) query.set("agent_name_hint", CHATGPT_AGENT_NAME_HINT);
      else if (idToken !== undefined) query.set("id_token_hint", idToken);
      if (consent) query.set("prompt", "consent");

      // The listener is live before the browser opens (C# starts HttpListener first,
      // then opens the browser on a background task WITHOUT awaiting it — the
      // callback loop and the browser navigation must run concurrently, because a
      // browser that blocks on its own redirect would deadlock against a server
      // that only responds once the browser returns).
      const queue = createCallbackQueue(server);
      const deadline = Date.now() + this.authorizationTimeoutMs;
      const browserOpen = openBrowser(new URL(`${CHATGPT_AUTHORIZE_URL}?${query.toString()}`)).then(
        () => new Promise<never>(() => {}), // opened: keep waiting for the callback
        (error: unknown) => {
          throw new ChatGptAuthError("Cannot open the browser for ChatGPT authorization.", "auth-failed", undefined, { cause: error });
        },
      );
      while (true) {
        const { req, res } = await withDeadline(Promise.race([queue.next(), browserOpen]), deadline, signal, "ChatGPT authorization timed out.");
        const url = new URL(req.url ?? "/", redirect);
        const values = url.searchParams;
        const valid = url.pathname === "/auth/callback" && values.get("state") === state;
        res.statusCode = valid ? 200 : 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(valid ? "Return to Di to finish sign-in." : "Invalid OAuth callback.");
        if (!valid) continue;
        if (values.has("error")) throw new ChatGptAuthError("ChatGPT authorization was declined or failed.", "auth-failed");
        const issued = values.get("client_id") ?? clientId;
        if (issued === undefined || issued.trim().length === 0 || issued === CHATGPT_DYNAMIC_CLIENT_ID || (clientId !== undefined && clientId !== issued)) {
          throw new ChatGptAuthError("Invalid OAuth callback client_id.", "invalid-data");
        }
        const code = values.get("code");
        if (code === null || code.trim().length === 0) throw new ChatGptAuthError("Missing OAuth callback code.", "invalid-data");
        return { code, clientId: issued, verifier, redirectUri: redirect };
      }
    } finally {
      await closeServer(server);
    }
  }

  private async requestToken(fields: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.tokenTimeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await this.http(CHATGPT_TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields).toString(),
          signal: controller.signal,
        });
      } catch (error) {
        if (isAbortError(error)) {
          if (signal?.aborted) throw new DOMException("aborted", "AbortError");
          throw new ChatGptAuthError("ChatGPT token endpoint timed out.", "timeout");
        }
        throw new ChatGptAuthError("Cannot reach OpenAI token endpoint.", "connection", undefined, { cause: error });
      }
      let token: unknown;
      try {
        token = await response.json();
      } catch {
        throw new ChatGptAuthError("Invalid OpenAI token response.", "bad-response");
      }
      if (token === null || typeof token !== "object" || Array.isArray(token)) {
        throw new ChatGptAuthError("Invalid OAuth token response.", "bad-response");
      }
      const body = token as Record<string, unknown>;
      if (!response.ok) {
        const code = tokenString(body, "error");
        throw new ChatGptAuthError("ChatGPT token exchange failed: " + code, code, response.status);
      }
      return body;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async getJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.http(url, { method: "GET", headers: {}, signal });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new ChatGptAuthError("Invalid discovery response.", "bad-response");
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ChatGptAuthError("Invalid discovery response.", "bad-response");
    }
    return value as Record<string, unknown>;
  }

  /** Open the system default browser (C# `ChatGptAuth.OpenSystemBrowserAsync`). */
  static async openSystemBrowser(uri: URL): Promise<void> {
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("cmd", ["/c", "start", "", uri.toString()], { windowsHide: true, stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("xdg-open", [uri.toString()], { stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", () => resolve());
      });
    }
  }
}

function globalFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

function tokenString(token: Record<string, unknown>, field: string): string {
  const value = token[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ChatGptAuthError("Invalid OAuth token field: " + field, "invalid-data");
  }
  return value;
}

function random(): string {
  return base64Url(randomBytes(32));
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "ascii").digest();
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Pushes every incoming callback request into a queue (a listener is always attached). */
function createCallbackQueue(server: Server): { next(): Promise<CallbackItem> } {
  const queue: CallbackItem[] = [];
  const waiters: Array<(item: CallbackItem) => void> = [];
  server.on("request", (req, res) => {
    const item: CallbackItem = { req, res };
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(item);
    else queue.push(item);
  });
  return {
    next(): Promise<CallbackItem> {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/** Wait for a value before the deadline (caller signal abort wins). */
async function withDeadline<T>(promise: Promise<T>, deadlineMs: number, signal: AbortSignal | undefined, timeoutMessage: string): Promise<T> {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    const remaining = Math.max(0, deadlineMs - Date.now());
    timer = setTimeout(() => reject(new ChatGptAuthError(timeoutMessage, "timeout")), remaining);
    onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();
  });
}
