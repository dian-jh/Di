import { homedir } from "node:os";
import { join } from "node:path";

import type { TextWriter } from "./io.ts";
import { createAclAdapter } from "../core/auth/acl.ts";
import { ChatGptAuth } from "../core/auth/chatgpt-auth.ts";
import { ChatGptAuthError } from "../core/auth/errors.ts";
import { CredentialStore } from "../core/auth/credential-store.ts";
import { LockUnavailableError, NativeOsLockProvider } from "../core/auth/lock-provider.ts";
import { DiHome } from "../core/config/di-home.ts";
import { createSystemProxyFetch } from "./windows-system-proxy.ts";

/** Recoverable message used when the host cannot acquire its credential lock. */
export const AUTH_CHATGPT_NOT_AVAILABLE = "ChatGPT authentication is unavailable because the credential lock could not be acquired.";
export const AUTH_USAGE = "Usage: di auth chatgpt login [--new] [--consent] | status | logout | models";

/** Default ChatGPT credential store with kernel locking and owner-only ACLs. */
export function defaultChatGptStore(): CredentialStore {
  const home = DiHome.fromEnvironment(process.env, homedir());
  return new CredentialStore({
    lock: new NativeOsLockProvider(),
    acl: createAclAdapter(),
    directory: join(home.rootDirectory, "auth", "chatgpt"),
  });
}

/** `di auth chatgpt...` command resolution. OAuth and token operations use ChatGptAuth. */
export async function runAuthCommand(
  args: readonly string[],
  stdout: TextWriter,
  stderr: TextWriter,
  store: CredentialStore = defaultChatGptStore(),
  auth: ChatGptAuth = new ChatGptAuth(store, { http: createSystemProxyFetch() }),
): Promise<number> {
  if (args.length < 3 || args[1] !== "chatgpt" || args.length > 5) {
    stderr.writeLine(AUTH_USAGE);
    return 1;
  }

  switch (args[2]) {
    case "login":
      if (args.slice(3).some((arg) => arg !== "--consent" && arg !== "--new")) {
        stderr.writeLine("ChatGPT: Use --new to register another ChatGPT connection.");
        return 1;
      }
      return runAuth(async () => {
        stdout.writeLine("Continue with ChatGPT — complete authorization in your browser (5 minute timeout).");
        await auth.signIn(ChatGptAuth.openSystemBrowser, args.includes("--new"), args.includes("--consent"));
        stdout.writeLine("ChatGPT connected. Run di auth chatgpt models to list models.");
      }, stderr);
    case "status":
      if (args.length !== 3) return unknownCommand(stderr);
      return runAuth(async () => {
        const status = await auth.status();
        stdout.writeLine(`ChatGPT: signed_in=${status.signedIn ? "True" : "False"} plan=${status.planEnabled ? "True" : "False"} client_id=${status.clientId ?? "none"}`);
      }, stderr);
    case "logout":
      if (args.length !== 3) return unknownCommand(stderr);
      return runAuth(async () => {
        const revoked = await auth.signOut();
        stdout.writeLine(revoked ? "Signed out of ChatGPT." : "Signed out locally. Remote revocation was not confirmed; disconnect the app in ChatGPT Settings.");
      }, stderr);
    case "models":
      if (args.length !== 3) return unknownCommand(stderr);
      return runAuth(async () => {
        for (const model of await auth.listModels()) stdout.writeLine(`chatgpt/${model}  ${model}`);
      }, stderr);
    default:
      return unknownCommand(stderr);
  }
}

async function runAuth(operation: () => Promise<void>, stderr: TextWriter): Promise<number> {
  try {
    await operation();
    return 0;
  } catch (error) {
    if (error instanceof LockUnavailableError || (error instanceof Error && "code" in error && error.code === "lock-unavailable")) {
      stderr.writeLine(AUTH_CHATGPT_NOT_AVAILABLE);
    } else if (error instanceof ChatGptAuthError) {
      stderr.writeLine(`ChatGPT: ${error.message}`);
    } else if (error instanceof Error && error.name === "AbortError") {
      stderr.writeLine("ChatGPT authorization cancelled or timed out.");
    } else {
      stderr.writeLine(`ChatGPT command failed: ${error instanceof Error ? error.name : "Error"}`);
    }
    return 1;
  }
}

function unknownCommand(stderr: TextWriter): number {
  stderr.writeLine("ChatGPT: Unknown ChatGPT auth command or arguments.");
  return 1;
}
