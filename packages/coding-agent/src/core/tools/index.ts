import type { ToolCall } from "@di/ai";
import type { ToolExecutor, ToolObservation } from "@di/agent";
import type { CoreTool } from "./types.ts";
import { createReadFileTool, type ReadFileToolOptions } from "./read.ts";
import { createWriteFileTool } from "./write.ts";
import { createEditFileTool } from "./edit.ts";
import { createGrepTool, type GrepToolOptions } from "./grep.ts";
import { createBashTool, PLATFORM_SHELL_NAME, type BashToolOptions } from "./bash.ts";
import { createPowerShellTool, type PowerShellToolOptions } from "./powershell.ts";
import { createPythonTool, type PythonToolOptions } from "./python.ts";

export type { CoreTool } from "./types.ts";
export type { ReadFileToolOptions } from "./read.ts";
export type { GrepToolOptions } from "./grep.ts";
export type { BashToolOptions } from "./bash.ts";
export type { PowerShellToolOptions } from "./powershell.ts";
export type { PythonToolOptions } from "./python.ts";
export { READ_FILE_MAX_BYTES, READ_FILE_MAX_OUTPUT_LINES, READ_FILE_MAX_OUTPUT_CHARS } from "./read.ts";
export { createReadFileTool } from "./read.ts";
export { createWriteFileTool } from "./write.ts";
export { createEditFileTool } from "./edit.ts";
export { createGrepTool, GREP_DEFAULT_LIMIT, GREP_DEFAULT_SCAN_BUDGET_MS, GREP_MAX_FILE_BYTES, GREP_MAX_MATCH_LINE_CHARS, GREP_REGEX_TIMEOUT_MS } from "./grep.ts";
export {
  createBashTool,
  BASH_DEFAULT_TIMEOUT_SECONDS,
  BASH_MAX_TIMEOUT_SECONDS,
  PLATFORM_SHELL_NAME,
} from "./bash.ts";
export {
  createPowerShellTool,
  POWERSHELL_DEFAULT_TIMEOUT_SECONDS,
  POWERSHELL_MAX_TIMEOUT_SECONDS,
} from "./powershell.ts";
export { createPythonTool, PYTHON_DEFAULT_TIMEOUT_SECONDS } from "./python.ts";
export {
  ShellSession,
  platformDefaultShell,
  platformSessionShell,
  powershellSessionShell,
} from "./shell-session.ts";
export type { ShellCommand, ShellSessionKind } from "./shell-session.ts";

/**
 * The three file tools in canonical order (read/write/edit), the first slice of
 * the 8-tool registry (`Core/Tools/CoreTools.cs` canonical order). Glob/grep,
 * the one-shot shell tool (`createBashTool`) and the PowerShell / Python tools
 * (`createPowerShellTool` / `createPythonTool`) extend the registry.
 */
export function createFileTools(
  baseDirectory: string,
  readFileOptions?: ReadFileToolOptions,
): readonly CoreTool[] {
  return [
    createReadFileTool(baseDirectory, readFileOptions),
    createWriteFileTool(baseDirectory),
    createEditFileTool(baseDirectory),
  ];
}

/**
 * Build an `@di/agent` `ToolExecutor` routing tool-call names to these tools.
 * Unknown names return an error observation (C# `Executor` behavior), and the
 * AbortSignal is passed through to the tool.
 *
 * P4.5 compatibility alias (C# `CoreTools` registry behavior): when the tool
 * set contains the platform shell tool (display name "cmd" on Windows / "bash"
 * elsewhere) and no tool is independently named "bash", the old "bash" call
 * name routes to the same instance — so legacy prompts that invoke "bash"
 * keep working on Windows.
 */
export function createToolExecutor(tools: readonly CoreTool[]): ToolExecutor {
  const byName = new Map<string, CoreTool>(tools.map((tool) => [tool.spec.name, tool]));
  if (!byName.has("bash") && byName.has(PLATFORM_SHELL_NAME)) {
    byName.set("bash", byName.get(PLATFORM_SHELL_NAME)!);
  }
  return {
    execute(call: ToolCall, signal?: AbortSignal): Promise<ToolObservation> {
      const tool = byName.get(call.name);
      if (tool === undefined) {
        return Promise.resolve({ text: `error: 未知工具 '${call.name}'`, isError: true });
      }
      return tool.execute(call.arguments, signal);
    },
  };
}
