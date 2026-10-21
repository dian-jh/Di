import { homedir } from "node:os";
import { join } from "node:path";

import type { TextWriter } from "./io.ts";
import { CredentialStore } from "../core/auth/credential-store.ts";
import { createAclAdapter } from "../core/auth/acl.ts";
import { FAIL_CLOSED_LOCK_PROVIDER, LockUnavailableError } from "../core/auth/lock-provider.ts";
import { CHATGPT_DIRECT_SCOPE } from "../core/auth/constants.ts";
import { DiHome } from "../core/config/di-home.ts";

/**
 * `di auth chatgpt ...` command resolution. Mirrors the argument validation of
 * C# `Di.Cli/ChatGptAuthCommand.cs` at baseline 09f4e08 (same usage line, same
 * per-subcommand shape checks and error strings).
 *
 * P8b wires every VALID subcommand to the host credential store through its
 * fail-closed lock seam: the default store uses {@link FAIL_CLOSED_LOCK_PROVIDER}
 * (no approved real OS-advisory-lock adapter yet), so each attempt surfaces the
 * contract-mandated recoverable error and the command FAILS CLOSED with an
 * honest "not yet available" message on stderr, exit 1. No fake credentials are
 * minted and no OAuth flow is faked. When a store IS available (tests inject a
 * mocked lock; a real lock adapter is a later optional enhancement), `status`
 * performs a genuine local read and prints the C#-mirrored status line; the
 * login/logout/models FLOWS still fail closed honestly until their real
 * pipelines are wired.
 */

/** Fail-closed gate message for every valid `auth chatgpt` subcommand (P8b). */
export const AUTH_CHATGPT_NOT_AVAILABLE =
  "ChatGPT 认证（auth chatgpt）尚未在 TypeScript 后端可用：宿主凭据存储按契约失败关闭——无真实 OS advisory lock 适配器（凭据已保留，不伪造凭据、不跑 OAuth；待真实锁适配器批准后启用）。";

export const AUTH_USAGE = "Usage: di auth chatgpt login [--new] [--consent] | status | logout | models";

/** The default store used by the CLI: fail-closed lock seam until a real adapter is approved. */
export function defaultChatGptStore(): CredentialStore {
  const home = DiHome.fromEnvironment(process.env, homedir());
  return new CredentialStore({
    lock: FAIL_CLOSED_LOCK_PROVIDER,
    acl: createAclAdapter(),
    directory: join(home.rootDirectory, "auth", "chatgpt"),
  });
}

export async function runAuthCommand(
  args: readonly string[],
  stdout: TextWriter,
  stderr: TextWriter,
  store: CredentialStore = defaultChatGptStore(),
): Promise<number> {
  // C#: args.Length < 3 || args[1] != "chatgpt" || args.Length > 5 → usage + exit 1.
  if (args.length < 3 || args[1] !== "chatgpt" || args.length > 5) {
    stderr.writeLine(AUTH_USAGE);
    return 1;
  }

  const subcommand = args[2]!;
  switch (subcommand) {
    case "login":
      // C#: any extra flag other than --consent/--new → ArgumentException.
      if (args.slice(3).some((a) => a !== "--consent" && a !== "--new")) {
        stderr.writeLine("ChatGPT: Use --new to register another ChatGPT connection.");
        return 1;
      }
      return attemptStore(store, async () => {
        await store.update(async () => {});
      }, stdout, stderr);
    case "status":
      if (args.length !== 3) {
        stderr.writeLine("ChatGPT: Unknown ChatGPT auth command or arguments.");
        return 1;
      }
      return attemptStore(store, async () => {
        const data = await store.read();
        const c = data.credential;
        stdout.writeLine(
          `ChatGPT: signed_in=${c?.accessToken !== undefined ? "True" : "False"} ` +
            `plan=${c?.scopes.includes(CHATGPT_DIRECT_SCOPE) ? "True" : "False"} client_id=${c?.clientId ?? "none"}`,
        );
        return true;
      }, stdout, stderr);
    case "logout":
      if (args.length !== 3) {
        stderr.writeLine("ChatGPT: Unknown ChatGPT auth command or arguments.");
        return 1;
      }
      return attemptStore(store, async () => {
        await store.update(async () => {});
      }, stdout, stderr);
    case "models":
      if (args.length !== 3) {
        stderr.writeLine("ChatGPT: Unknown ChatGPT auth command or arguments.");
        return 1;
      }
      return attemptStore(store, async () => {
        await store.update(async () => {});
      }, stdout, stderr);
    default:
      stderr.writeLine("ChatGPT: Unknown ChatGPT auth command or arguments.");
      return 1;
  }
}

/**
 * Attempt the store through the lock seam. A `lock-unavailable` (the contract-
 * mandated fail-closed default) surfaces the honest message and exit 1. If the
 * store is genuinely available the operation runs — `status` handles the result
 * and returns 0; the login/logout/models flows are not yet wired, so they still
 * fail closed honestly.
 */
async function attemptStore(
  store: CredentialStore,
  operation: () => Promise<boolean | void>,
  stdout: TextWriter,
  stderr: TextWriter,
): Promise<number> {
  let handled = false;
  try {
    const result = await operation();
    handled = result === true;
  } catch (error) {
    if (error instanceof LockUnavailableError || (error instanceof Error && "code" in error && error.code === "lock-unavailable")) {
      stderr.writeLine(AUTH_CHATGPT_NOT_AVAILABLE);
    } else {
      stderr.writeLine(`ChatGPT: ${errorMessage(error)}`);
    }
    return 1;
  }
  if (handled) return 0;
  stderr.writeLine(AUTH_CHATGPT_NOT_AVAILABLE);
  return 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
