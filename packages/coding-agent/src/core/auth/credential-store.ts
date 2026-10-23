import { mkdir, open, readFile, rename as fsRename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { AclAdapter } from "./acl.ts";
import type { LockProvider } from "./lock-provider.ts";
import { ChatGptAuthError } from "./errors.ts";
import { CHATGPT_DIRECT_SCOPE } from "./constants.ts";

/*
 * Atomic owner-only credential storage (`ChatGptCredentialStore` @).
 *
 * The ONLY write path is {@link CredentialStore.update}: acquire the cross-process
 * exclusive lock → re-read the latest credentials INSIDE the lock → apply the
 * change (refresh / login / logout) → validate → atomic replace. The lock covers
 * read, network refresh and commit, so two processes can never consume a
 * one-time refresh token (models-and-auth.md line ~153-156).
 *
 * Atomic replace: a unique temp file in the same directory → write → `fh.sync` →
 * close → `rename` overwrite. On failure the old file is preserved and the orphan
 * temp file is cleaned. The ACL adapter protects the directory and the temp file
 * before it is committed; any ACL failure refuses the token write (fail closed).
 *
 * The lock is the DI-injectable {@link LockProvider} seam. Production composition
 * supplies the native OS lock provider; tests may inject a synthetic provider.
 * `open('wx')` here only names the temp file (a unique random name, never a lock);
 * it is never used as a lock.
 *
 * Reading tolerates the legacy shape (`Accounts` + `ActiveClientId`, PascalCase
 * fields, ISO dates) and migrates it atomically while preserving the active
 * credential (models-and-auth.md line ~165). The canonical write format is
 * camelCase JSON with epoch-millis timestamps.
 */

/** Corrupt / malformed credentials file — reported, never silently treated as empty. */
export class CredentialDataError extends Error {
  readonly code = "credential-data" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialDataError";
  }
}

/** `NeedsRefresh`: within 3 minutes of expiry, gated by earliest-refresh-at (and always when expired). */
export function needsRefresh(
  cred: Pick<ChatGptCredential, "expiresAt" | "earliestRefreshAt">,
  nowMs: number = Date.now(),
): boolean {
  return (
    cred.expiresAt <= nowMs + 3 * 60_000 &&
    (cred.earliestRefreshAt === undefined || cred.earliestRefreshAt <= nowMs || cred.expiresAt <= nowMs)
  );
}

export interface ChatGptCredentialInit {
  readonly clientId: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
  readonly earliestRefreshAt?: number;
}

/*
 * Mutable credential (the class: in-place `clearTokens` / field writes
 * are captured by the enclosing store transaction). The ID token is kept only as
 * an opaque authorization hint and is never decoded into a claimed identity.
 */
export class ChatGptCredential {
  readonly clientId: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  scopes: readonly string[];
  expiresAt: number;
  earliestRefreshAt?: number;

  constructor(init: ChatGptCredentialInit) {
    this.clientId = init.clientId;
    this.accessToken = init.accessToken;
    this.refreshToken = init.refreshToken;
    this.idToken = init.idToken;
    this.scopes = init.scopes;
    this.expiresAt = init.expiresAt;
    this.earliestRefreshAt = init.earliestRefreshAt;
  }

  get needsRefresh(): boolean {
    return needsRefresh(this);
  }

  /** Terminal credential refusal: clear tokens but retain the issued registration. */
  clearTokens(): void {
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.idToken = undefined;
    this.scopes = [];
  }

  /** Validate a token response and build a credential (`ChatGptCredential.FromToken`). */
  static fromToken(token: Record<string, unknown>, clientId: string, previous?: ChatGptCredential, nowMs: number = Date.now()): ChatGptCredential {
    const access = tokenString(token, "access_token");
    const refresh = tokenString(token, "refresh_token");
    const expiresIn = token["expires_in"];
    if (typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn <= 0) {
      throw new ChatGptAuthError("Invalid OAuth token field: expires_in", "invalid-data");
    }
    const scopeValue = token["scope"];
    const scopes =
      typeof scopeValue === "string" && scopeValue.trim().length > 0
        ? scopeValue.split(/\s+/)
        : previous !== undefined
          ? [...previous.scopes]
          : [];
    if (!scopes.includes(CHATGPT_DIRECT_SCOPE)) {
      throw new ChatGptAuthError("ChatGPT grant did not include " + CHATGPT_DIRECT_SCOPE, "invalid-data");
    }
    const tokenType = token["token_type"];
    if (tokenType !== undefined && !(typeof tokenType === "string" && tokenType.toLowerCase() === "bearer")) {
      throw new ChatGptAuthError("Unsupported OAuth token_type.", "invalid-data");
    }
    const earliest = token["earliest_refresh_at"];
    return new ChatGptCredential({
      clientId,
      accessToken: access,
      refreshToken: refresh,
      scopes,
      idToken: typeof token["id_token"] === "string" ? token["id_token"] : previous?.idToken,
      expiresAt: nowMs + expiresIn * 1000,
      earliestRefreshAt: typeof earliest === "number" && Number.isFinite(earliest) ? earliest * 1000 : previous?.earliestRefreshAt,
    });
  }
}

export interface ChatGptCredentials {
  hostId: string;
  credential?: ChatGptCredential;
}

export interface CredentialStoreOptions {
  readonly lock: LockProvider;
  readonly acl: AclAdapter;
  readonly directory: string;
  /** rename seam (testability / crash simulation); defaults to `fs.promises.rename`. */
  readonly rename?: (from: string, to: string) => Promise<void>;
}

export class CredentialStore {
  readonly directory: string;
  readonly credentialsPath: string;
  readonly lockPath: string;

  private readonly lock: LockProvider;
  private readonly acl: AclAdapter;
  private readonly rename: (from: string, to: string) => Promise<void>;

  constructor(options: CredentialStoreOptions) {
    this.directory = options.directory;
    this.credentialsPath = join(options.directory, "credentials.json");
    this.lockPath = join(options.directory, "session.lock");
    this.lock = options.lock;
    this.acl = options.acl;
    this.rename = options.rename ?? fsRename;
  }

  /** Read under the lock (a status read never refreshes; it is local). */
  async read(signal?: AbortSignal): Promise<ChatGptCredentials> {
    const handle = await this.lock.acquire(this.lockPath, { signal });
    try {
      return await this.readUnlocked();
    } finally {
      await handle.release();
    }
  }

  /*
 * The single write path: login, logout and rotating refresh share this
 * transaction. The lock is held across re-read → change → atomic replace.
 */
  async update(change: (data: ChatGptCredentials) => Promise<void> | void, signal?: AbortSignal): Promise<ChatGptCredentials> {
    const handle = await this.lock.acquire(this.lockPath, { signal });
    try {
      const data = await this.readUnlocked();
      await change(data);
      await this.writeUnlocked(data);
      return data;
    } finally {
      await handle.release();
    }
  }

  private async readUnlocked(): Promise<ChatGptCredentials> {
    let raw: string;
    try {
      raw = await readFile(this.credentialsPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return { hostId: "urn:uuid:" + randomUUID() };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CredentialDataError("Invalid ChatGPT credentials file.");
    }
    return parseCredentials(parsed);
  }

  private async writeUnlocked(data: ChatGptCredentials): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.acl.secureDirectory(this.directory);
    const temp = join(this.directory, randomUUID() + ".tmp");
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // Unique random name: `wx` here creates the temp file, it is NOT a lock.
      fh = await open(temp, "wx");
      await this.acl.secureFile(temp);
      await fh.writeFile(serializeCredentials(data), "utf8");
      await fh.sync();
      await fh.close();
      fh = undefined;
      await this.rename(temp, this.credentialsPath);
    } finally {
      if (fh !== undefined) await fh.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
    }
  }
}

function serializeCredentials(data: ChatGptCredentials): string {
  const credential = data.credential;
  const value: Record<string, unknown> = { hostId: data.hostId };
  if (credential !== undefined) {
    value["credential"] = {
      clientId: credential.clientId,
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      idToken: credential.idToken,
      scopes: credential.scopes,
      expiresAt: credential.expiresAt,
      earliestRefreshAt: credential.earliestRefreshAt,
    };
  }
  return JSON.stringify(value, null, 2);
}

function parseCredentials(raw: unknown): ChatGptCredentials {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CredentialDataError("Invalid ChatGPT credentials file.");
  }
  const obj = raw as Record<string, unknown>;
  const hostId = pick(obj, "hostId", "HostId");
  const credentialRaw = pick(obj, "credential", "Credential");
  let credential: ChatGptCredential | undefined;
  if (credentialRaw !== undefined) {
    credential = parseCredential(credentialRaw);
  } else {
    // Legacy upgrade: { Accounts: [...], ActiveClientId: "..." }.
    const accounts = pick(obj, "Accounts");
    const activeClientId = pick(obj, "ActiveClientId");
    if (Array.isArray(accounts) && typeof activeClientId === "string") {
      const match = (accounts as unknown[]).find((account) => pick(account as Record<string, unknown>, "ClientId") === activeClientId);
      if (match !== undefined) credential = parseCredential(match);
    }
  }
  return {
    hostId: typeof hostId === "string" && hostId.trim().length > 0 ? hostId : "urn:uuid:" + randomUUID(),
    credential,
  };
}

function parseCredential(raw: unknown): ChatGptCredential {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CredentialDataError("Invalid ChatGPT credential.");
  }
  const obj = raw as Record<string, unknown>;
  const clientId = pick(obj, "clientId", "ClientId");
  const expiresAt = pickEpochMs(obj, "expiresAt", "ExpiresAt");
  if (typeof clientId !== "string" || clientId.length === 0 || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new CredentialDataError("Invalid ChatGPT credential: missing clientId or expiresAt.");
  }
  const scopesRaw = pick(obj, "scopes", "Scopes");
  const scopes = Array.isArray(scopesRaw) ? scopesRaw.filter((s): s is string => typeof s === "string") : [];
  return new ChatGptCredential({
    clientId,
    accessToken: pickString(obj, "accessToken", "AccessToken"),
    refreshToken: pickString(obj, "refreshToken", "RefreshToken"),
    idToken: pickString(obj, "idToken", "IdToken"),
    scopes,
    expiresAt,
    earliestRefreshAt: pickEpochMs(obj, "earliestRefreshAt", "EarliestRefreshAt"),
  });
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  const value = pick(obj, ...keys);
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Epoch-millis number, or an ISO date string (legacy DateTimeOffset). */
function pickEpochMs(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  const value = pick(obj, ...keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = isoToMs(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

function isoToMs(value: string): number {
  // JS Date.parse handles at most 3 fractional digits; writes 7.
  const trimmed = value.replace(/\.(\d{3})\d*/, ".$1");
  return Date.parse(trimmed);
}

function tokenString(token: Record<string, unknown>, field: string): string {
  const value = token[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ChatGptAuthError("Invalid OAuth token field: " + field, "invalid-data");
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}
