import type { ToolCall } from "@di/ai";
import type { ToolExecutor, ToolObservation } from "@di/agent";
import type { CoreTool } from "./types.ts";
import { createReadFileTool, type ReadFileToolOptions } from "./read.ts";
import { createWriteFileTool } from "./write.ts";
import { createEditFileTool } from "./edit.ts";

export type { CoreTool } from "./types.ts";
export type { ReadFileToolOptions } from "./read.ts";
export { READ_FILE_MAX_BYTES, READ_FILE_MAX_OUTPUT_LINES, READ_FILE_MAX_OUTPUT_CHARS } from "./read.ts";
export { createReadFileTool } from "./read.ts";
export { createWriteFileTool } from "./write.ts";
export { createEditFileTool } from "./edit.ts";

/**
 * The three file tools in canonical order (read/write/edit), the first slice of
 * the 8-tool registry (`Core/Tools/CoreTools.cs` canonical order). Glob/grep and
 * the shell/process tools arrive in later P4 cards and extend this list.
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
 */
export function createToolExecutor(tools: readonly CoreTool[]): ToolExecutor {
  const byName = new Map<string, CoreTool>(tools.map((tool) => [tool.spec.name, tool]));
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
