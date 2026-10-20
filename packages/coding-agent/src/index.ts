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
export {
  createGrepTool,
  GREP_DEFAULT_LIMIT,
  GREP_DEFAULT_SCAN_BUDGET_MS,
  GREP_MAX_FILE_BYTES,
  GREP_MAX_MATCH_LINE_CHARS,
  GREP_REGEX_TIMEOUT_MS,
} from "./core/tools/grep.ts";
export type { CoreTool } from "./core/tools/index.ts";
export type { ReadFileToolOptions } from "./core/tools/read.ts";
export type { GlobToolOptions } from "./core/tools/glob.ts";
export type { GrepToolOptions } from "./core/tools/grep.ts";
export {
  BoundedByteBuffer,
  OutputBuffer,
  OUTPUT_HEAD_BYTES,
  OUTPUT_HEAD_CHARS,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_CHARS,
  OUTPUT_TAIL_BYTES,
  OUTPUT_TAIL_CHARS,
} from "./core/tools/output-buffer.ts";
export {
  PROCESS_DRAIN_BUDGET_MS,
  PROCESS_KILL_BUDGET_MS,
  ProcessResult,
  runProcess,
} from "./core/tools/process-runner.ts";
export type { ProcessRunOptions } from "./core/tools/process-runner.ts";

export { AgentSession, SessionBusyError, SessionModelError, SessionRecoveryBlockedError } from "./core/agent-session.ts";
export type {
  ActiveSkill,
  AgentSessionConfig,
  AgentSessionDeps,
  SessionTurnOptions,
} from "./core/agent-session.ts";

// P5 sessions: JSONL checkpoint codec / writer / recovery / stats.
export { SessionDataError } from "./core/sessions/errors.ts";
export type { SessionErrorCode } from "./core/sessions/errors.ts";
export {
  nowUtcIso,
  parseCheckpointBlock,
  parseCheckpointMessage,
  serializeCheckpointBlock,
  serializeCheckpointMessage,
  serializeEnvelope,
} from "./core/sessions/codec.ts";
export { SessionStore } from "./core/sessions/session-log.ts";
export type { CheckpointTurnCompletion, SessionLogOptions } from "./core/sessions/session-log.ts";
export { loadRecovery, RECOVERY_NOT_EXECUTED_NOTE } from "./core/sessions/session-recovery.ts";
export { aggregateSessionStats } from "./core/sessions/session-stats.ts";
export type { SessionStatsSummary } from "./core/sessions/session-stats.ts";
export { InputBudgetTracker, estimateMemoryTokens, estimateTokenCount } from "./core/budget.ts";
export {
  dropOldestTurns,
  sanitizeHistory,
  trimHistoryByTokens,
  trimHistoryByTurns,
  userMessageCount,
} from "./core/history.ts";
export { buildEnvironmentSnapshot } from "./core/environment-snapshot.ts";

// P6.2a + P6.2b skills: SKILL.md frontmatter parsing, repository discovery and
// same-source conflict resolution (P6.2a); matching, activation, disclosure
// (advertise + load_skill) and metadata handling (P6.2b).
export {
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  SkillFormatError,
} from "./core/skills/skill.ts";
export type { Skill } from "./core/skills/skill.ts";
export { parseSkillMarkdown } from "./core/skills/skill-markdown.ts";
export {
  ancestorAgentsSkillDirectories,
  projectAgentsSkillsDirectory,
  userAgentsSkillsDirectory,
} from "./core/skills/skill-locations.ts";
export type { AncestorSkillDiscoveryOptions } from "./core/skills/skill-locations.ts";
export { loadSkills, loadSkillsFromUserAndProject } from "./core/skills/skill-repository.ts";
export type { ISkillMatcher, LexicalSkillMatcherOptions, SkillMatch } from "./core/skills/skill-matcher.ts";
export { LexicalSkillMatcher } from "./core/skills/skill-matcher.ts";
export { computeSkillActivation } from "./core/skills/skill-activation.ts";
export type { SkillActivationResult } from "./core/skills/skill-activation.ts";
export { buildAdvertisement, buildSkillSystemContext, estimateSkillTokens } from "./core/skills/skill-context.ts";
export {
  LOAD_SKILL_TOOL,
  createSkillAwareExecutor,
  executeLoadSkill,
  isLoadSkillCall,
  renderLoadedSkill,
} from "./core/skills/skill-tools.ts";

// P6.3b CLI: pure argument parsing, mode resolution, the dispatch shell and the
// non-interactive modes (version/info/help/list-models/stats/skill-eval), plus the
// `auth chatgpt` command resolution that fails closed on the P8b platform gate.
export {
  CliArgsParser,
} from "./cli/args.ts";
export type { CliArgs, CliArgsParseResult, CliDiagnostic } from "./cli/args.ts";
export { AppMode, CliMode } from "./cli/mode.ts";
export { CLI_NAME, CLI_VERSION, CliInfo, HELP_TEXT } from "./cli/cli-info.ts";
export { LineTextReader, StringTextWriter, nullTextReader } from "./cli/io.ts";
export type { TextReader, TextWriter } from "./cli/io.ts";
export type { CliHost, CliHostFactory } from "./cli/cli-host.ts";
export { defaultCliHostFactory } from "./cli/cli-host.ts";
export { CliApp } from "./cli/cli-app.ts";
export { AUTH_CHATGPT_NOT_AVAILABLE, AUTH_USAGE, runAuthCommand } from "./cli/auth-command.ts";

// P6.3c modes + output contracts: event bus / renderer, the interactive (REPL +
// TUI launcher) / print / json / rpc mode bodies, the session-runner seam and the
// host extension (command registry / AgentSession-backed runner / session store /
// currentModel + reasoning seams).
export { EventBus, EventConsumer } from "./core/events/event-bus.ts";
export type { TurnRunner } from "./cli/cli-host.ts";
export { createSessionRunner } from "./modes/turn-runner.ts";
export { EventRenderer, drainEvents, formatUsage, renderAll, usageCostTotal } from "./modes/event-renderer.ts";
export { errorMessage, resolvePrompt } from "./modes/common.ts";
export { runPrintMode } from "./modes/print-mode.ts";
export { runJsonMode } from "./modes/json-mode.ts";
export { runRpcMode } from "./modes/rpc-mode.ts";
export { DEFAULT_REPL_OPTIONS, Repl, runInteractive } from "./modes/repl.ts";
export type { ReplOptions } from "./modes/repl.ts";
export { TUI_DEFAULT_RELATIVE_ENTRY, tryLaunchTui } from "./modes/tui-launcher.ts";
export type { TuiDecision, TuiLauncherContext } from "./modes/tui-launcher.ts";

// P6.3b skills: labeled case loader + matcher quality/cost metrics (--skill-eval).
export { loadSkillCases } from "./core/skills/skill-case-loader.ts";
export type { SkillTestCase } from "./core/skills/skill-case-loader.ts";
export { evaluateSkillSet } from "./core/skills/skill-evaluator.ts";
export type { SkillMetrics } from "./core/skills/skill-evaluator.ts";

// P6.3a commands: builtin slash command registry, user command Markdown/loader
// and model selection (provider/model resolution + reasoning tier).
export {
  MAX_COMMAND_DESCRIPTION_LENGTH,
  MAX_COMMAND_NAME_LENGTH,
  CommandFormatException,
  parseCommandMarkdown,
} from "./core/commands/command-markdown.ts";
export type { UserCommand } from "./core/commands/command-markdown.ts";
export { loadCommandsInto } from "./core/commands/command-loader.ts";
export type { CommandResult, SlashCommand, SlashCommandHandler } from "./core/commands/slash-command.ts";
export { HANDLED, QUIT, turnCommand } from "./core/commands/slash-command.ts";
export { SlashCommandRegistry } from "./core/commands/slash-command-registry.ts";
export type { CommandContext, CommandHost, CommandOutput } from "./core/commands/command-context.ts";
export { StringCommandOutput } from "./core/commands/command-context.ts";
export { createBuiltinCommands, createBuiltinRegistry } from "./core/commands/builtin-commands.ts";
export { ModelReference, ModelSelection, ModelSelectionError } from "./core/model-selection.ts";
export type {
  ModelInfo,
  ModelReasoningInfo,
  ModelSelectionErrorCode,
  ModelSelectionHost,
  ModelSelectionOptions,
  ModelService,
  ProviderInfo,
  ReasoningEffortInfo,
  ResolvedModelInfo,
} from "./core/model-selection.ts";
