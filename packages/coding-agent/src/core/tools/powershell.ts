import { stat } from "node:fs/promises";
import { getOptionalInt, getRequiredString, parseArguments, toolSchema } from "./args.ts";
import { messageOf } from "./errors.ts";
import { hasIllegalPathChars, resolvePath } from "./paths.ts";
import { ShellSession, powershellSessionShell } from "./shell-session.ts";
import { errorObservation, okObservation, type CoreTool } from "./types.ts";

/**
 * The PowerShell tool (port of `Core/Tools/PowerShellTool.cs` at 09f4e08), same
 * dual-mode design as C#:
 * - persistent-session mode (a {@link ShellSession} with the PowerShell shell is
 *   injected): cd / variables / environment persist across calls; `working_dir`
 *   is not in the schema and is ignored if the model passes it anyway.
 * - one-shot mode (no session): every call runs in a fresh temporary PowerShell
 *   session with an optional `working_dir`.
 *
 * Timeout: default 30s, hard cap 3600s, per-call `timeout` override. A timeout
 * kills the session tree and the next call self-heals (the persistent session is
 * lazily respawned). Chinese round-trips via UTF-8 stdin / UTF-8 stdout with the
 * engine's OEM-encoded stderr decoded by smart decode (never CLIXML pollution).
 */

/** Default per-call timeout in seconds (C# `PowerShellTool.DefaultTimeoutSeconds`). */
export const POWERSHELL_DEFAULT_TIMEOUT_SECONDS = 30;
/** Hard per-call timeout cap in seconds (C# `PowerShellTool.MaxTimeoutSeconds`). */
export const POWERSHELL_MAX_TIMEOUT_SECONDS = 3600;

export interface PowerShellToolOptions {
  /** Default per-call timeout in seconds (C# `timeout` ctor; default 30). */
  readonly timeoutSeconds?: number;
  /** A shared persistent PowerShell session; when present the tool is in session mode. */
  readonly session?: ShellSession;
}

/** Optional string; blank/whitespace is treated as absent (C# `TryGetOptionalString`). */
function optionalString(args: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Create the PowerShell tool. `baseDirectory` is the one-shot fallback working
 * directory; inject a `session` for persistent-session mode.
 */
export function createPowerShellTool(baseDirectory: string, options?: PowerShellToolOptions): CoreTool {
  const session = options?.session;
  const defaultTimeoutSeconds = options?.timeoutSeconds ?? POWERSHELL_DEFAULT_TIMEOUT_SECONDS;

  // ---- definition / prompt (session vs one-shot flavor) ----
  const description = session !== undefined
    ? "在共享的持久化 PowerShell 会话中执行一条命令，返回退出码与合并后的输出（stdout + stderr）。" +
      "cd、变量、环境变量等状态在多次调用之间保持——切换目录请用 cd（Set-Location），而不是 working_dir。" +
      `命令超时（默认 ${POWERSHELL_DEFAULT_TIMEOUT_SECONDS} 秒，可用 timeout 参数覆盖，单位秒）会终止会话并在下次调用时自动重建。长输出自动截断头尾。`
    : "在 PowerShell 中执行一条命令，返回退出码与合并后的输出（stdout + stderr）。" +
      `命令超时（默认 ${POWERSHELL_DEFAULT_TIMEOUT_SECONDS} 秒，可用 timeout 参数覆盖，单位秒）会被终止并返回 error。长输出自动截断头尾。`;

  const promptSnippet = session !== undefined
    ? "在共享持久化 PowerShell 会话中执行命令"
    : "在 PowerShell 中一次性执行命令，返回退出码与合并输出";

  const promptGuidelines = session !== undefined
    ? [
        "powershell 是共享持久化会话：cd、变量、环境变量等状态跨调用保持，切换目录用 cd（Set-Location）而不是 working_dir",
        "超时（默认 30 秒，可 timeout 覆盖）会终止命令并返回 error，会话自动重建",
      ]
    : [
        "每次调用都是独立的一次性 PowerShell 进程，cwd/环境变量不跨调用保持；切换目录用 working_dir 参数",
        "超时（默认 30 秒，可 timeout 覆盖）会终止命令并返回 error；长输出自动截断头尾",
      ];

  return {
    spec: {
      name: "powershell",
      description,
      parameters: session !== undefined
        ? toolSchema(
            [["command", "string", "要在 PowerShell 中执行的命令"]],
            [["timeout", "integer", `可选：超时秒数（默认 ${POWERSHELL_DEFAULT_TIMEOUT_SECONDS}，最大 ${POWERSHELL_MAX_TIMEOUT_SECONDS}）`]],
          )
        : toolSchema(
            [["command", "string", "要在 PowerShell 中执行的命令"]],
            [
              ["timeout", "integer", `可选：超时秒数（默认 ${POWERSHELL_DEFAULT_TIMEOUT_SECONDS}，最大 ${POWERSHELL_MAX_TIMEOUT_SECONDS}）`],
              ["working_dir", "string", "可选：工作目录（默认工作区根目录）"],
            ],
          ),
    },
    promptSnippet,
    promptGuidelines,
    async execute(argumentsJson, signal) {
      const parsed = parseArguments(argumentsJson);
      if (!parsed.ok) return errorObservation(parsed.error);

      const commandResult = getRequiredString(parsed.value, "command");
      if (!commandResult.ok) return errorObservation(commandResult.error);

      const timeoutResult = getOptionalInt(parsed.value, "timeout");
      if (!timeoutResult.ok) return errorObservation(timeoutResult.error);
      const timeoutArg = timeoutResult.value;
      if (timeoutArg !== undefined && (timeoutArg <= 0 || timeoutArg > POWERSHELL_MAX_TIMEOUT_SECONDS)) {
        return errorObservation(`error: timeout 必须是 1 到 ${POWERSHELL_MAX_TIMEOUT_SECONDS} 之间的整数秒`);
      }
      const timeoutMs = (timeoutArg ?? defaultTimeoutSeconds) * 1000;

      // Session mode: the command runs in the shared persistent session; cwd/env
      // survive across calls, so `working_dir` is deliberately ignored (C#).
      if (session !== undefined) {
        const result = await session.execute(commandResult.value, timeoutMs, signal);
        return result.error === null
          ? okObservation(result.toObservation())
          : errorObservation(result.toObservation());
      }

      // One-shot mode: a fresh temporary PowerShell session carries the command,
      // its working directory pinned at spawn time (C# `new ShellSession(...)`).
      const workingDirArg = optionalString(parsed.value, "working_dir");
      let workingDir: string;
      try {
        if (workingDirArg !== undefined && hasIllegalPathChars(workingDirArg)) {
          throw new Error("路径包含非法字符");
        }
        workingDir = workingDirArg === undefined ? baseDirectory : resolvePath(baseDirectory, workingDirArg);
      } catch (error) {
        return errorObservation(`error: 路径参数非法: ${messageOf(error)}`);
      }
      try {
        const dir = await stat(workingDir);
        if (!dir.isDirectory()) {
          return errorObservation(`error: 工作目录不存在: ${workingDirArg}`);
        }
      } catch {
        return errorObservation(`error: 工作目录不存在: ${workingDirArg}`);
      }

      const oneShot = new ShellSession(workingDir, powershellSessionShell);
      try {
        const result = await oneShot.execute(commandResult.value, timeoutMs, signal);
        return result.error === null
          ? okObservation(result.toObservation())
          : errorObservation(result.toObservation());
      } finally {
        oneShot.dispose();
      }
    },
  };
}
