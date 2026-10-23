/*
 * @di/coding-agent — Node host composition root.
 *
 * Public TypeScript host package: AgentSession, tools, skills, session/config/auth
 * storage, CLI modes, and the `di-ts` entry point.
 */

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
export {
  createBashTool,
  BASH_DEFAULT_TIMEOUT_SECONDS,
  BASH_MAX_TIMEOUT_SECONDS,
  PLATFORM_SHELL_NAME,
} from "./core/tools/bash.ts";
export {
  createPowerShellTool,
  POWERSHELL_DEFAULT_TIMEOUT_SECONDS,
  POWERSHELL_MAX_TIMEOUT_SECONDS,
} from "./core/tools/powershell.ts";
export { createPythonTool, PYTHON_DEFAULT_TIMEOUT_SECONDS } from "./core/tools/python.ts";
export { ShellSession, platformDefaultShell, platformSessionShell, powershellSessionShell } from "./core/tools/shell-session.ts";
export type { ShellCommand, ShellSessionKind } from "./core/tools/shell-session.ts";
export type { CoreTool } from "./core/tools/index.ts";
export type { ReadFileToolOptions } from "./core/tools/read.ts";
export type { GlobToolOptions } from "./core/tools/glob.ts";
export type { GrepToolOptions } from "./core/tools/grep.ts";
export type { BashToolOptions } from "./core/tools/bash.ts";
export type { PowerShellToolOptions } from "./core/tools/powershell.ts";
export type { PythonToolOptions } from "./core/tools/python.ts";
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
export type { ProcessDiagnosticsOptions, ProcessRunOptions } from "./core/tools/process-runner.ts";

export { AgentSession, SessionBusyError, SessionModelError, SessionRecoveryBlockedError } from "./core/agent-session.ts";
export type {
  ActiveSkill,
  AgentSessionConfig,
  AgentSessionDeps,
  SessionTurnOptions,
} from "./core/agent-session.ts";

// sessions: JSONL checkpoint codec / writer / recovery / stats.
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
export { BudgetPolicy, CompactingExecutor, FileArtifactStore } from "./core/context-management.ts";
export type { ArtifactStore, BudgetPolicyOptions } from "./core/context-management.ts";
export {
  dropOldestTurns,
  sanitizeHistory,
  trimHistoryByTokens,
  trimHistoryByTurns,
  userMessageCount,
} from "./core/history.ts";
export { buildEnvironmentSnapshot } from "./core/environment-snapshot.ts";

// + skills: SKILL.md frontmatter parsing, repository discovery and
// same-source conflict resolution; matching, activation, disclosure
// (advertise + load_skill) and metadata handling.
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

// CLI: pure argument parsing, mode resolution, the dispatch shell and the
// non-interactive modes (version/info/help/list-models/stats/skill-eval), plus the
// `auth chatgpt` command resolution that fails closed on the platform gate.
export {
  CliArgsParser,
} from "./cli/args.ts";
export type { CliArgs, CliArgsParseResult, CliDiagnostic } from "./cli/args.ts";
export { AppMode, CliMode } from "./cli/mode.ts";
export { CLI_NAME, CLI_VERSION, CliInfo, HELP_TEXT } from "./cli/cli-info.ts";
export { LineTextReader, StringTextWriter, createStdinReader, nullTextReader } from "./cli/io.ts";
export type { TextReader, TextWriter } from "./cli/io.ts";
export type { CliHost, CliHostFactory } from "./cli/cli-host.ts";
export { defaultCliHostFactory } from "./cli/cli-host.ts";
export { createCliHost } from "./cli/cli-host-compose.ts";
export type { ComposeCliHostOptions } from "./cli/cli-host-compose.ts";
export { CliApp } from "./cli/cli-app.ts";
export { createDefaultProviderRuntime } from "./cli/provider-runtime.ts";
export type { DefaultProviderRuntimeOptions } from "./cli/provider-runtime.ts";
export { AUTH_CHATGPT_NOT_AVAILABLE, AUTH_USAGE, defaultChatGptStore, runAuthCommand } from "./cli/auth-command.ts";

// host ChatGPT auth: OAuth PKCE, the credential store with its fail-closed
// lock seam, the ACL adapter and the LockProvider interface. The default lock
// provider fails closed (no approved real OS-advisory-lock adapter yet); the
// transaction logic (lock → re-read → refresh → validate → atomic replace) is
// verified with a DI-injected mock lock. Do NOT claim runtime storage is enabled.
export { ChatGptAuth } from "./core/auth/chatgpt-auth.ts";
export { ChatGptAuthError } from "./core/auth/errors.ts";
export type { ChatGptAuthOptions, ChatGptStatus, FetchLike } from "./core/auth/chatgpt-auth.ts";
export { ChatGptCredential, CredentialDataError, CredentialStore, needsRefresh } from "./core/auth/credential-store.ts";
export type { ChatGptCredentialInit, ChatGptCredentials, CredentialStoreOptions } from "./core/auth/credential-store.ts";
export { AclError, createAclAdapter } from "./core/auth/acl.ts";
export type { AclAdapter, AclAdapterOptions } from "./core/auth/acl.ts";
export { FAIL_CLOSED_LOCK_PROVIDER, LockUnavailableError, NativeOsLockProvider } from "./core/auth/lock-provider.ts";
export type { LockAcquireOptions, LockHandle, LockProvider } from "./core/auth/lock-provider.ts";
export {
  CHATGPT_AGENT_NAME_HINT,
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_DIRECT_SCOPE,
  CHATGPT_DISCOVERY_URL,
  CHATGPT_DYNAMIC_CLIENT_ID,
  CHATGPT_RESOURCE,
  CHATGPT_SCOPES,
  CHATGPT_TOKEN_URL,
} from "./core/auth/constants.ts";

// modes + output contracts: event bus / renderer, the interactive (REPL +
// TUI launcher) / print / json / rpc mode bodies, the session-runner seam and the
// host extension (command registry / AgentSession-backed runner / session store /
// currentModel + reasoning seams).
export { EventBus, EventConsumer } from "./core/events/event-bus.ts";
export type { EventHandler } from "./core/events/event-bus.ts";
export type { LogEvent, ModelCallStartedEvent, RunStartedEvent } from "./core/events/log-events.ts";
export { ModelCallProbe } from "./core/events/model-call-probe.ts";

// run logging: per-day lifecycle log (DiLog + DiLogOptions + LogLevel) and
// the ProcessDiagnostics static hook (default no-op; host wires it to DiLog).
export { DiLog, LogLevel, redactSensitive } from "./core/logging/di-log.ts";
export type { DiLogOptions } from "./core/logging/di-log.ts";
export { ProcessDiagnostics } from "./core/logging/process-diagnostics.ts";
export type { ProcessDiagnosticSink } from "./core/logging/process-diagnostics.ts";
export type { TurnRunner } from "./cli/cli-host.ts";
export { createSessionRunner } from "./modes/turn-runner.ts";
export { EventRenderer, drainEvents, formatUsage, renderAll, usageCostTotal } from "./modes/event-renderer.ts";
export { errorMessage, resolvePrompt } from "./modes/common.ts";
export { runPrintMode } from "./modes/print-mode.ts";
export { runJsonMode } from "./modes/json-mode.ts";
export { runRpcMode } from "./modes/rpc-mode.ts";
export { DEFAULT_REPL_OPTIONS, Repl, runInteractive, runInteractiveLocal, tryLaunchLocalTui } from "./modes/repl.ts";
export type { ReplOptions } from "./modes/repl.ts";

// in-process TUI runner: the LocalAgentRunnerAdapter converts Core
// AgentEvent/AgentResult → protocol wire RpcAgentEvent/RpcAgentResult (the ONLY
// conversion point; shared with --mode rpc via modes/wire.ts). The adapter
// implements di-tui's RunnerPort; the CLI interactive mode hands it to
// di-tui.runInteractive (DI direction coding-agent → di-tui).
export { LocalAgentRunnerAdapter } from "./adapters/tui-runner.ts";
export { TUI_DEFAULT_RELATIVE_ENTRY, tryLaunchTui } from "./modes/tui-launcher.ts";
export type { TuiDecision, TuiLauncherContext } from "./modes/tui-launcher.ts";

// skills: labeled case loader + matcher quality/cost metrics (--skill-eval).
export { loadSkillCases } from "./core/skills/skill-case-loader.ts";
export type { SkillTestCase } from "./core/skills/skill-case-loader.ts";
export { evaluateSkillSet } from "./core/skills/skill-evaluator.ts";
export type { SkillMetrics } from "./core/skills/skill-evaluator.ts";

// commands: builtin slash command registry, user command Markdown/loader
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
export { CatalogModelService } from "./cli/cli-host-compose.ts";
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
