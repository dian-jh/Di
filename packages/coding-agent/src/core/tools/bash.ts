import { stat } from "node:fs/promises";
import { getOptionalInt, getRequiredString, parseArguments, toolSchema } from "./args.ts";
import { messageOf } from "./errors.ts";
import { resolvePath } from "./paths.ts";
import { runProcess } from "./process-runner.ts";
import { ShellSession } from "./shell-session.ts";
import { errorObservation, okObservation, type CoreTool } from "./types.ts";

/**
 * Platform-default-shell tool (port of `Core/Tools/BashTool.cs` at 09f4e08).
 * Without a session it executes one command in the platform shell with optional
 * `working_dir`; with a session it shares a persistent terminal whose cwd and
 * environment survive across calls. Both modes support per-call timeout and
 * merged bounded output.
 *
 * Persistent mode uses the shared `ShellSession` implementation; the host owns
 * and disposes its lifetime. One-shot mode remains available for custom tools
 * and tests.
 *
 * C# contract mapping:
 * - platform default shell -> `runProcess(..., { shell: true })`: Node itself
 *   builds `comspec /d /s /c "<command>"` on Windows (equivalent to C# passing
 *   `rawArguments = $"/d /s /c \"{command}\""` — embedded quotes survive
 *   verbatim, `&` / redirection / `%CD%` work) and `/bin/sh -c <command>` on
 *   POSIX (one arg, equivalent to C# `ShellCommand.Default` args array). All
 *   lifecycle semantics (tree kill, bounded drain, timeout/cancel, startup
 *   failure) come from `runProcess` unchanged.
 * - injected custom shell (tests) -> args-array mode
 *   `runProcess(shell, [command], ...)` (C# `new List<string>(PrefixArguments)
 *   { command }`).
 *
 * Documented migration differences from C#:
 * - PromptSnippet/PromptGuidelines reflect the selected execution mode.
 * - `runProcess` diagnostics report `name=<basename(command)>` — i.e. the whole
 *   command line — for shell-mode calls (the underlying process is the shell
 *   wrapping the command). Accepted and noted in the card report.
 */

/** Default per-call timeout in seconds (C# `BashTool.DefaultTimeoutSeconds`). */
export const BASH_DEFAULT_TIMEOUT_SECONDS = 30;
/** Hard per-call timeout cap in seconds (C# `BashTool.MaxTimeoutSeconds`). */
export const BASH_MAX_TIMEOUT_SECONDS = 3600;
/** The platform default shell's model-facing display name (C# `CoreTools.PlatformShellName`). */
export const PLATFORM_SHELL_NAME: "cmd" | "bash" = process.platform === "win32" ? "cmd" : "bash";

export interface BashToolOptions {
  /**
   * Custom shell executable (tests only, C# `ShellCommand`): when provided the
   * command is run in args-array mode; when omitted the platform default shell
   * is used in `shell: true` mode. No real PowerShell/Python shells here.
   */
  readonly shell?: string;
  /** Default per-call timeout in seconds (C# `timeout` ctor; default 30). */
  readonly timeoutSeconds?: number;
  /** Shared persistent platform shell; cwd and environment survive across calls. */
  readonly session?: ShellSession;
}

/** Optional string; blank/whitespace is treated as absent (C# `TryGetOptionalString` returns null for it). */
function optionalString(args: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** True when the path contains a character that can never appear in a filesystem path (C# `Path.GetInvalidPathChars` — NUL on every platform, plus control chars 0x00–0x1F on Windows). */
function hasIllegalPathChars(p: string): boolean {
  if (p.includes("\0")) return true;
  if (process.platform !== "win32") return false;
  for (let i = 0; i < p.length; i += 1) {
    if (p.charCodeAt(i) < 32) return true;
  }
  return false;
}

/**
 * `createBashTool(baseDirectory, opts?)` returns the platform shell tool
 * (`cmd` on Windows, `bash` otherwise), in one-shot or shared-session mode.
 */
export function createBashTool(baseDirectory: string, options?: BashToolOptions): CoreTool {
  const defaultTimeoutSeconds = options?.timeoutSeconds ?? BASH_DEFAULT_TIMEOUT_SECONDS;
  const customShell = options?.shell;
  const session = options?.session;
  const windows = PLATFORM_SHELL_NAME === "cmd";

  const description = windows
    ? "在 Windows 命令提示符（cmd.exe）中执行一条命令，返回退出码与合并后的输出（stdout + stderr）。" +
      "cmd.exe 没有 ls/tail/head/pwd/grep 命令：列目录用 dir、看文件用 type、搜文本用 findstr、看当前目录用 echo %CD%。" +
      `命令超时（默认 ${defaultTimeoutSeconds} 秒，可用 timeout 参数覆盖，单位秒）会被终止并返回 error。长输出自动截断头尾。`
    : "在 shell 中执行一条命令，返回退出码与合并后的输出（stdout + stderr）。" +
      `命令超时（默认 ${defaultTimeoutSeconds} 秒，可用 timeout 参数覆盖，单位秒）会被终止并返回 error。长输出自动截断头尾。`;

  const promptSnippet = windows
    ? "在 Windows 命令提示符（cmd.exe）中一次性执行命令，返回退出码与合并输出"
    : "在 shell 中一次性执行命令，返回退出码与合并输出";

  const promptGuidelines = windows
    ? [
        "Windows cmd.exe 没有 ls/tail/head/pwd/grep：列目录用 dir、看文件用 type、搜文本用 findstr、看当前目录用 echo %CD%",
        "每次调用都是独立的一次性进程，cwd/环境变量不跨调用保持；切换目录用 working_dir 参数",
        "超时（默认 30 秒，可 timeout 覆盖）会终止命令并返回 error；长输出自动截断头尾",
      ]
    : [
        "每次调用都是独立的一次性进程，cwd/环境变量不跨调用保持；切换目录用 working_dir 参数",
        "超时（默认 30 秒，可 timeout 覆盖）会终止命令并返回 error；长输出自动截断头尾",
      ];

  const sessionDescription = windows
    ? "在共享的持久化 cmd.exe 会话中执行一条命令（stdout + stderr 合并）。cd、环境变量和激活的虚拟环境等状态在多次调用之间保持；切换目录请用 cd，而不是 working_dir。"
    : "在共享的持久化终端会话中执行一条命令（stdout + stderr 合并）。cd、环境变量和激活的虚拟环境等状态在多次调用之间保持；切换目录请用 cd，而不是 working_dir。";
  const sessionSnippet = windows ? "在共享持久化 cmd.exe 会话中执行命令" : "在共享持久化终端会话中执行命令";
  const sessionGuidelines = windows
    ? ["cmd 是共享持久化会话：cd、环境变量、激活的虚拟环境等状态跨调用保持，切换目录用 cd 而不是 working_dir", "Windows cmd.exe 没有 ls/tail/head/pwd/grep：列目录用 dir、看文件用 type、搜文本用 findstr、看当前目录用 echo %CD%", "超时会终止会话并在下次调用自动重建"]
    : ["bash 是共享持久化会话：cd、环境变量、激活的虚拟环境等状态跨调用保持，切换目录用 cd 而不是 working_dir", "超时会终止会话并在下次调用自动重建"];

  return {
    spec: {
      name: PLATFORM_SHELL_NAME,
      description: session === undefined ? description : sessionDescription,
      parameters: toolSchema(
        [["command", "string", "要执行的命令"]],
        [
          ["timeout", "integer", `可选：超时秒数（默认 ${BASH_DEFAULT_TIMEOUT_SECONDS}，最大 ${BASH_MAX_TIMEOUT_SECONDS}）`],
          ...(session === undefined ? [["working_dir", "string", "可选：工作目录（默认工作区根目录）"] as [string, string, string]] : []),
        ],
      ),
    },
    promptSnippet: session === undefined ? promptSnippet : sessionSnippet,
    promptGuidelines: session === undefined ? promptGuidelines : sessionGuidelines,
    async execute(argumentsJson, signal) {
      const parsed = parseArguments(argumentsJson);
      if (!parsed.ok) return errorObservation(parsed.error);

      const commandResult = getRequiredString(parsed.value, "command");
      if (!commandResult.ok) return errorObservation(commandResult.error);

      const timeoutResult = getOptionalInt(parsed.value, "timeout");
      if (!timeoutResult.ok) return errorObservation(timeoutResult.error);
      const timeoutArg = timeoutResult.value;
      if (timeoutArg !== undefined && (timeoutArg <= 0 || timeoutArg > BASH_MAX_TIMEOUT_SECONDS)) {
        return errorObservation(`error: timeout 必须是 1 到 ${BASH_MAX_TIMEOUT_SECONDS} 之间的整数秒`);
      }
      const timeoutMs = (timeoutArg ?? defaultTimeoutSeconds) * 1000;

      if (session !== undefined) {
        const result = await session.execute(commandResult.value, timeoutMs, signal);
        return result.error === null ? okObservation(result.toObservation()) : errorObservation(result.toObservation());
      }

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
      // Async stat (never sync IO on the tool path, tools-and-platform.md); a
      // missing directory — or a path that is a file, like C# `Directory.Exists`
      // — is the documented "工作目录不存在" observation (C# Directory.Exists).
      try {
        const dir = await stat(workingDir);
        if (!dir.isDirectory()) {
          return errorObservation(`error: 工作目录不存在: ${workingDirArg}`);
        }
      } catch {
        return errorObservation(`error: 工作目录不存在: ${workingDirArg}`);
      }

      // Platform default shell -> shell: true mode (Node builds the cmd / sh -c
      // wrapper, C# rawArguments parity). Injected custom shell -> args array.
      const result =
        customShell === undefined
          ? await runProcess(commandResult.value, [], {
              shell: true,
              cwd: workingDir,
              timeoutMs,
              signal,
            })
          : await runProcess(customShell, [commandResult.value], {
              cwd: workingDir,
              timeoutMs,
              signal,
            });

      // AbortError propagates to the loop (never converted to an error
      // observation); ProcessResult already rendered `exit: N` / `error: …`.
      // A result with `error` set (startup failure / timeout) is an isError
      // observation; a non-zero exit code stays a plain `exit: N` observation.
      return result.error === null
        ? okObservation(result.toObservation())
        : errorObservation(result.toObservation());
    },
  };
}
