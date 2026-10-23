import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { getRequiredString, parseArguments, toolSchema } from "./args.ts";
import { messageOf } from "./errors.ts";
import { hasIllegalPathChars, resolvePath } from "./paths.ts";
import { runProcess } from "./process-runner.ts";
import { errorObservation, okObservation, type CoreTool } from "./types.ts";

/*
 * The Python tool: executes code
 * via `python -c <code>` in a standalone process whose default working directory
 * is the system temp dir. Process-level isolation only — NOT an OS sandbox, and
 * no filesystem/network restriction is claimed. stdin starts at EOF (redirected
 * then closed, `closeStdin`), the timeout force-kills the tree, and output is
 * forced to UTF-8 on both ends (`PYTHONIOENCODING=utf-8` pinned + UTF-8 decode).
 */

/** Default per-call timeout in seconds (`PythonTool.DefaultTimeoutSeconds`). */
export const PYTHON_DEFAULT_TIMEOUT_SECONDS = 30;

export interface PythonToolOptions {
  /** Default per-call timeout in seconds (`timeout` ctor; default 30). */
  readonly timeoutSeconds?: number;
  /** Default working directory (`sandboxDirectory`; default the system temp dir). */
  readonly sandboxDirectory?: string;
}

/** Optional string; blank/whitespace is treated as absent (`TryGetOptionalString`). */
function optionalString(args: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/*
 * Create the Python tool. `executable` defaults to `python` on PATH (ctor
 * default); a nonexistent executable is a startup-failure observation.
 */
export function createPythonTool(executable?: string, options?: PythonToolOptions): CoreTool {
  const pythonExecutable = executable ?? "python";
  const defaultTimeoutSeconds = options?.timeoutSeconds ?? PYTHON_DEFAULT_TIMEOUT_SECONDS;
  const sandboxDirectory = options?.sandboxDirectory ?? tmpdir();

  return {
    spec: {
      name: "python",
      description:
        "执行一段 Python 代码，返回退出码与合并后的输出（stdout + stderr）。" +
        "独立进程的默认工作目录为系统临时目录（不限制文件访问）。" +
        `超时（${PYTHON_DEFAULT_TIMEOUT_SECONDS} 秒）会被终止并返回 error。长输出自动截断头尾。`,
      parameters: toolSchema(
        [["code", "string", "要执行的 Python 代码"]],
        [["working_dir", "string", "可选：工作目录（默认系统临时目录）"]],
      ),
    },
    promptSnippet: "在独立进程中执行一段 Python 代码",
    promptGuidelines: ["超时返回 error，长输出自动截断"],
    async execute(argumentsJson, signal) {
      const parsed = parseArguments(argumentsJson);
      if (!parsed.ok) return errorObservation(parsed.error);

      const codeResult = getRequiredString(parsed.value, "code");
      if (!codeResult.ok) return errorObservation(codeResult.error);

      const workingDirArg = optionalString(parsed.value, "working_dir");
      let workingDir: string;
      try {
        if (workingDirArg !== undefined && hasIllegalPathChars(workingDirArg)) {
          throw new Error("路径包含非法字符");
        }
        workingDir = workingDirArg === undefined ? sandboxDirectory : resolvePath(sandboxDirectory, workingDirArg);
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

      // Python output encoding drifts with the environment (PYTHONIOENCODING /
      // PYTHONUTF8 / Python version can all make it write UTF-8 instead of OEM
      // bytes, garbling Chinese on a GBK machine). Pin both ends to UTF-8 so the
      // behavior is machine-independent ( note).
      const result = await runProcess(
        pythonExecutable,
        ["-c", codeResult.value],
        {
          cwd: workingDir,
          env: { PYTHONIOENCODING: "utf-8" },
          outputEncoding: "utf-8",
          timeoutMs: defaultTimeoutSeconds * 1000,
          signal,
          // redirectInput: true — stdin is a pipe closed immediately to EOF,
          // so the code can never touch the caller's terminal.
          stdio: ["pipe", "pipe", "pipe"],
          closeStdin: true,
        },
      );

      return result.error === null
        ? okObservation(result.toObservation())
        : errorObservation(result.toObservation());
    },
  };
}
