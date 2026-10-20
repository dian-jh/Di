/**
 * @di/coding-agent — Node host composition root.
 *
 * P1 status: compilable workspace stub. AgentSession, CoreRunner, builtin tools,
 * skills, session/config/auth storage, modes and the CLI bin are implemented in
 * later phases per execution-plan.md and architecture.md.
 */

/** Placeholder export so the package resolves in workspace dependency order. */
export const packageStatus = "stub" as const;

export { DiHome } from "./core/config/di-home.ts";
export type { DiHomeEnvironment } from "./core/config/di-home.ts";
export { ConfigParseError, parseJsonc, parseJsonObject } from "./core/config/jsonc.ts";
export { DEFAULT_CONFIG, DiConfig, defaultReadFile } from "./core/config/di-config.ts";
export type { ConfigValue, DiConfigDeps, DiConfigSources } from "./core/config/di-config.ts";

export { createReadFileTool, createWriteFileTool, createEditFileTool, createFileTools, createToolExecutor } from "./core/tools/index.ts";
export {
  READ_FILE_MAX_BYTES,
  READ_FILE_MAX_OUTPUT_LINES,
  READ_FILE_MAX_OUTPUT_CHARS,
} from "./core/tools/read.ts";
export { createGlobTool, GLOB_DEFAULT_LIMIT, GLOB_DEFAULT_SCAN_BUDGET_MS } from "./core/tools/glob.ts";
export { globIsMatch, globToRegex } from "./core/tools/glob-matcher.ts";
export type { CoreTool } from "./core/tools/index.ts";
export type { ReadFileToolOptions } from "./core/tools/read.ts";
export type { GlobToolOptions } from "./core/tools/glob.ts";
