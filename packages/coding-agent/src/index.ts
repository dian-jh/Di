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
