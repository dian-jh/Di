import type { TextWriter } from "./io.ts";

/**
 * `di auth chatgpt ...` command resolution. Mirrors the argument validation of
 * C# `Di.Cli/ChatGptAuthCommand.cs` at baseline 09f4e08 (same usage line, same
 * per-subcommand shape checks and error strings). The actual OAuth
 * sign-in / status / logout / models flows are P8b and BLOCKED on the unresolved
 * Windows-ACL/lock credential-store platform gate: every VALID subcommand FAILS
 * CLOSED with an honest "not yet available" message on stderr and exit 1. No
 * fake credentials are minted and no OAuth flow is faked — the gate is reported
 * as unresolved, never papered over.
 */

/** The gate message every valid `auth chatgpt` subcommand hits (P8b blocked). */
export const AUTH_CHATGPT_NOT_AVAILABLE =
  "ChatGPT 认证（auth chatgpt）尚未在 TypeScript 后端可用：P8b 宿主凭据存储被 Windows-ACL/lock 平台门槛阻塞，已失败关闭（不伪造凭据或 OAuth 流程）。";

export const AUTH_USAGE = "Usage: di auth chatgpt login [--new] [--consent] | status | logout | models";

export function runAuthCommand(args: readonly string[], stdout: TextWriter, stderr: TextWriter): number {
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
      break;
    case "status":
    case "logout":
    case "models":
      if (args.length !== 3) {
        stderr.writeLine("ChatGPT: Unknown ChatGPT auth command or arguments.");
        return 1;
      }
      break;
    default:
      stderr.writeLine("ChatGPT: Unknown ChatGPT auth command or arguments.");
      return 1;
  }

  stderr.writeLine(AUTH_CHATGPT_NOT_AVAILABLE);
  return 1;
}
