import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import type { AgentResult, ToolExecutor } from "@di/agent";
import type { ChatModel, ModelRequest } from "@di/ai";
import { DeepSeekAdapter, MODEL_CATALOG } from "@di/ai";
import { AgentSession } from "../core/agent-session.ts";
import { estimateMemoryTokens } from "../core/budget.ts";
import { createBuiltinRegistry } from "../core/commands/builtin-commands.ts";
import { loadCommandsInto } from "../core/commands/command-loader.ts";
import { DEFAULT_CONFIG, DiConfig, defaultReadFile } from "../core/config/di-config.ts";
import { DiHome } from "../core/config/di-home.ts";
import { EventBus } from "../core/events/event-bus.ts";
import { ModelCallProbe } from "../core/events/model-call-probe.ts";
import { DiLog, LogLevel } from "../core/logging/di-log.ts";
import { ProcessDiagnostics } from "../core/logging/process-diagnostics.ts";
import type { ModelInfo, ModelSelectionHost, ModelService, ProviderInfo, ResolvedModelInfo } from "../core/model-selection.ts";
import { ModelReference, ModelSelection } from "../core/model-selection.ts";
import { loadRecovery } from "../core/sessions/session-recovery.ts";
import { SessionStore } from "../core/sessions/session-log.ts";
import { ancestorAgentsSkillDirectories, userAgentsSkillsDirectory } from "../core/skills/skill-locations.ts";
import { loadSkills } from "../core/skills/skill-repository.ts";
import { createSkillAwareExecutor, LOAD_SKILL_TOOL } from "../core/skills/skill-tools.ts";
import type { Skill } from "../core/skills/skill.ts";
import { createBashTool, createFileTools, createToolExecutor } from "../core/tools/index.ts";
import { createGlobTool } from "../core/tools/glob.ts";
import { createGrepTool } from "../core/tools/grep.ts";
import type { CoreTool } from "../core/tools/types.ts";
import { DEFAULT_REPL_OPTIONS } from "../modes/repl.ts";
import { createSessionRunner } from "../modes/turn-runner.ts";
import { CLI_VERSION } from "./cli-info.ts";
import type { CliHost, CliHostFactory, TurnRunner } from "./cli-host.ts";
import type { CliArgs } from "./args.ts";
import type { TextWriter } from "./io.ts";

/**
 * The REAL composition root (C# `Di.Cli/CliHost.Create` at baseline 09f4e08),
 * replacing the P6.3b fail-closed `defaultCliHostFactory` stub: assemble config /
 * tools (P4.x) / skills (P6.2) / sessionStore (P5) / AgentSession / DiLog (P6.4) /
 * createSessionRunner into one {@link CliHost} every mode drives.
 *
 * P7 wiring decisions:
 * - `--resume` loads the trajectory through {@link loadRecovery} FIRST (a
 *   recovery failure throws and becomes the documented host-failure envelope —
 *   never an empty session), then {@link AgentSession.restoreHistory};
 * - the current-model LABEL is resolved to the session's `ChatModel` at turn
 *   boundaries (`AgentSessionConfig.resolveModel`) and on `setCurrentModel`
 *   (`session.setModel`) — the provider router defaults to the DeepSeek adapter
 *   (API key resolved at request time, exactly like C#; ChatGPT stays fail-closed
 *   behind the P8b platform gate);
 * - the P6.4 emission seams are closed here: `runStarted` is published before
 *   every `session.runTurn`, and every resolved model is wrapped in
 *   {@link ModelCallProbe} so `modelCallStarted` reaches the bus on each call;
 * - `DiLog` subscribes to the bus, writes `di starting pid=… workspace=…`, and
 *   `ProcessDiagnostics.log` is injected into `DiLog.log`; `dispose()` writes
 *   `di exiting`, closes the file and clears the static hook.
 *
 * Everything is injectable so tests never touch the network or the user's home:
 * diHome / config / modelFactory / modelService / tools / skills /
 * estimateRequestTokens / clock.
 */

/** Composition-root injection points (tests replace the real defaults; production uses none). */
export interface ComposeCliHostOptions {
  /** DI_HOME override (default: `DiHome.fromEnvironment(process.env, homedir())`). */
  readonly diHome?: DiHome;
  /** Pre-loaded effective config (default: layered DiConfig.load from the standard sources). */
  readonly config?: DiConfig;
  /** Label → ChatModel resolver (default: provider router over DeepSeek / fail-closed ChatGPT). */
  readonly modelFactory?: (label: string) => ChatModel;
  /** Advisory model catalog service (default: MODEL_CATALOG-backed, auth checks are env/local only). */
  readonly modelService?: ModelService;
  /** Tool set (default: file/glob/grep tools over the workspace). */
  readonly tools?: readonly CoreTool[];
  /** Skills (default: discovered from user / DI_HOME / ancestor / project locations). */
  readonly skills?: readonly Skill[];
  /** Request-token estimate for the loop guard + history trimming (default: memory estimate). */
  readonly estimateRequestTokens?: (request: ModelRequest) => number;
  /** DiLog clock (tests inject a fake clock for deterministic line timestamps). */
  readonly clock?: () => Date;
}

/** Global cross-tool operation rules contributed to the system prompt (C# `CoreTools.GlobalPromptGuidelines`). */
const GLOBAL_PROMPT_GUIDELINES = [
  '观察结果以 "exit: N"（退出码）或 "error: ..."（出错）开头；error 表示修正参数后重试',
  "长输出会被截断（保留头尾）；必要时缩小搜索范围或分批读取",
  "回答要简洁",
];

/**
 * Build the tool-usage instructions injected as the stable system-prompt prefix
 * (C# `CoreTools.BuildInstructions`): a one-line list of the available tools and
 * the de-duplicated operation rules contributed by the tools themselves.
 */
export function buildToolInstructions(tools: readonly CoreTool[]): string {
  const lines = ["你是 Di 编程助手，可以在工作区中读取、编写、修改文件，并运行命令与代码。", "", "工具："];
  for (const tool of tools) lines.push(`- ${tool.spec.name} —— ${tool.promptSnippet}`);
  lines.push("", "规则：");
  const seen = new Set<string>();
  const rules: string[] = [];
  const addRule = (rule: string): void => {
    const normalized = rule.trim();
    if (normalized.length === 0 || seen.has(normalized)) return;
    seen.add(normalized);
    rules.push(normalized);
  };
  for (const rule of GLOBAL_PROMPT_GUIDELINES) addRule(rule);
  for (const tool of tools) {
    for (const rule of tool.promptGuidelines) addRule(rule);
  }
  for (const rule of rules) lines.push(`- ${rule}`);
  return lines.join("\n");
}

/** Build the real host. A thrown recovery/config error becomes the host-failure envelope. */
export async function createCliHost(
  args: CliArgs,
  workspace: string,
  stderr: TextWriter,
  useAnsi: boolean,
  options: ComposeCliHostOptions = {},
): Promise<CliHost> {
  if (args == null) throw new TypeError("createCliHost: args is required");
  if (typeof workspace !== "string" || workspace.trim().length === 0) {
    throw new TypeError("createCliHost: workspace is required");
  }
  if (stderr == null) throw new TypeError("createCliHost: stderr is required");

  // --resume: loadRecovery BEFORE anything else. A failure throws here and rides
  // the CliApp host-failure envelope (json → `session_resume`, text → stderr) —
  // never fake an empty session (P6.3c).
  const resumeHistory =
    args.resume !== undefined ? loadRecovery(resolvePath(args.resume)) : undefined;

  const diHome = options.diHome ?? DiHome.fromEnvironment(process.env, homedir());
  const config =
    options.config ??
    (await DiConfig.load(
      {
        defaults: DEFAULT_CONFIG,
        userConfigPath: diHome.configFile,
        projectConfigPath: DiHome.projectConfigFile(workspace),
        env: process.env,
      },
      { readFile: defaultReadFile },
    ));

  // Effective model options (C# `ModelOptions` + CLI overrides): --provider swaps
  // the provider route, --model overrides the default model label.
  const configuredProvider = asString(config.get("model:provider"), "deepseek");
  const configuredDefaultModel = asString(config.get("model:defaultmodel"), "deepseek-flash");
  const effectiveProvider = !isBlank(args.provider) ? args.provider! : configuredProvider;
  const defaultModel = args.model ?? configuredDefaultModel;

  // Tools: the P4.x set in canonical order read/write/edit/glob/grep/bash over
  // the workspace (C# `CoreTools` canonical order first slice; the one-shot
  // shell tool lands here so the "运行命令与代码" instruction is honest).
  const tools = options.tools ?? [
    ...createFileTools(workspace),
    createGlobTool(workspace),
    createGrepTool(workspace),
    createBashTool(workspace),
  ];
  const toolSpecs = tools.map((tool) => tool.spec);

  // Skills: standard locations in priority order (C# `CliHost.Create`): user
  // ~/.agents/skills → DI_HOME/skills → ancestor .agents/skills (nearest→git root)
  // → project <workspace>/.di/skills (highest). Invalid files only warn.
  const userHome = homedir();
  const skills =
    options.skills ??
    loadSkills(
      [
        userAgentsSkillsDirectory(userHome),
        diHome.skillsDirectory,
        ...ancestorAgentsSkillDirectories(workspace),
        join(DiHome.projectDirectory(workspace), "skills"),
      ],
      (msg) => stderr.writeLine(`⚠ ${msg}`),
    );

  // System prompt: config `AgentLoop:SystemPrompt` overrides the built instructions.
  const configuredSystemPrompt = asOptionalString(config.get("agentloop:systemprompt"));
  const systemPrompt =
    configuredSystemPrompt ??
    buildToolInstructions(tools) + "\n\n你是一个简洁的 ReAct 助手。需要事实信息时调用工具，不要编造。回答用中文。";

  const bus = new EventBus();
  const label: { currentModel: string; setCurrentModel?: (model: string) => void } = { currentModel: defaultModel };

  // Model resolution: the current-model LABEL is resolved to the session's
  // ChatModel (P7 wiring). Every resolved model is wrapped in a ModelCallProbe so
  // `modelCallStarted` is published on each call — a fresh probe per turn
  // (resolveModel) makes its counter equal the loop's iteration counter.
  const wrapWithProbe = (inner: ChatModel): ChatModel => new ModelCallProbe(inner, bus);
  const resolveLabel = (modelLabel: string): ChatModel => {
    const factory = options.modelFactory ?? ((l: string) => defaultModelForLabel(l, effectiveProvider, config));
    return wrapWithProbe(factory(modelLabel));
  };

  const estimateRequestTokens =
    options.estimateRequestTokens ?? ((request: ModelRequest) => estimateMemoryTokens(request.messages));

  const sessionStore = args.noSession ? undefined : new SessionStore({ rootDirectory: diHome.rootDirectory });

  // Skill-aware executor (C# `AgentRunner`): with skills present, expose the
  // load_skill tool to the model and intercept its calls; otherwise the plain
  // executor over the core tool set.
  const baseExecutor = createToolExecutor(tools);
  const toolExecutor: ToolExecutor =
    skills.length > 0 ? createSkillAwareExecutor(baseExecutor, skills) : baseExecutor;
  const modelTools = skills.length > 0 ? [...toolSpecs, LOAD_SKILL_TOOL] : toolSpecs;

  let reasoningEffort = args.thinking ?? asOptionalString(config.get("agentloop:reasoningeffort"));
  let busy = false;

  const session = new AgentSession(
    {
      systemPrompt,
      tools: modelTools,
      workingDirectory: workspace,
      ...(sessionStore !== undefined ? { sessionStore } : {}),
      events: (event) => bus.publish(event),
      resolveModel: () => resolveLabel(label.currentModel),
    },
    {
      model: resolveLabel(label.currentModel),
      toolExecutor,
      estimateRequestTokens,
    },
  );
  if (resumeHistory !== undefined) session.restoreHistory(resumeHistory);

  label.setCurrentModel = (modelLabel: string): void => {
    session.setModel(resolveLabel(modelLabel));
  };

  const sessionRunner = createSessionRunner(session, label);

  // The host's runner IS the ModelSelectionHost seam: it publishes runStarted
  // before every turn and tracks the busy flag that rejects mid-turn model
  // switches (C# `AgentRunner.RunAsync` publishes RunStarted; ModelSelection
  // pre-checks the busy session).
  const runner: TurnRunner & ModelSelectionHost = {
    get currentModel(): string {
      return label.currentModel;
    },
    setCurrentModel(modelLabel: string): void {
      sessionRunner.setCurrentModel(modelLabel);
    },
    resetHistory(): void {
      sessionRunner.resetHistory();
    },
    setActiveSkills(skillsForTurn: readonly Skill[]): void {
      sessionRunner.setActiveSkills(skillsForTurn);
    },
    runTurn(userMessage: string, signal?: AbortSignal): Promise<AgentResult> {
      busy = true;
      bus.publish({ type: "runStarted", userMessage });
      return sessionRunner.runTurn(userMessage, signal).finally(() => {
        busy = false;
      });
    },
    isBusy(): boolean {
      return busy;
    },
    onReasoningChanged(effort: string | null): void {
      reasoningEffort = effort ?? undefined;
    },
  };

  const models = new ModelSelection(
    options.modelService ?? new CatalogModelService(),
    runner,
    {
      defaultProvider: effectiveProvider,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    },
  );

  const commands = createBuiltinRegistry();
  loadCommandsInto(commands, diHome.commandsDirectory, (msg) => stderr.writeLine(`⚠ ${msg}`));

  // Run log (P6.4): bus bypass subscription + startup line + ProcessDiagnostics
  // hook; the dispose chain writes `di exiting`, closes the file and clears the
  // static hook.
  const diLog = new DiLog({
    rootDirectory: diHome.rootDirectory,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  diLog.subscribe(bus);
  diLog.log(LogLevel.Info, `di starting pid=${process.pid} version=${CLI_VERSION} workspace=${workspace}`);
  ProcessDiagnostics.log = (msg) => diLog.log(LogLevel.Info, msg);

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    diLog.dispose();
    if (ProcessDiagnostics.log !== null) ProcessDiagnostics.log = null;
  };

  return {
    models,
    skills,
    runner,
    bus,
    commands,
    ...(sessionStore !== undefined ? { sessionStore } : {}),
    get reasoningEffort() {
      return reasoningEffort;
    },
    replOptions: { ...DEFAULT_REPL_OPTIONS, useAnsi },
    dispose,
  };
}

/** The production host factory (C# `Func<CliArgs, string, TextWriter, bool, CliHost>`). */
export const defaultCliHostFactory: CliHostFactory = createCliHost;

/**
 * Advisory model catalog (C# `ILlmService` subset): deepseek / chatgpt routes
 * from the shared `MODEL_CATALOG` (models-and-auth.md). Refresh is in-memory (the
 * catalog is advisory, never a network call); auth checks are local env/config
 * probes only — deepseek requires the API key present, ChatGPT stays fail-closed
 * behind the P8b platform gate.
 */
class CatalogModelService implements ModelService {
  listProviders(): readonly ProviderInfo[] {
    return Object.keys(MODEL_CATALOG).map((id) => ({ id, name: providerName(id) }));
  }

  listModels(provider?: string): readonly ModelInfo[] {
    const all: ModelInfo[] = [];
    for (const [providerId, specs] of Object.entries(MODEL_CATALOG)) {
      if (provider !== undefined && provider !== providerId) continue;
      for (const spec of specs) {
        all.push({ provider: providerId, id: spec.id, name: spec.name });
      }
    }
    return all;
  }

  async refreshModels(provider: string): Promise<readonly ModelInfo[]> {
    return this.listModels(provider);
  }

  async checkAuth(provider: string): Promise<boolean> {
    if (provider === "deepseek") return !isBlank(process.env.DEEPSEEK_API_KEY);
    return false; // ChatGPT auth / credential storage: blocked by the P8b platform gate.
  }

  async resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    const spec = MODEL_CATALOG[provider]?.find((m) => m.id === id);
    return { provider, id, name: spec?.name ?? id };
  }
}

/**
 * Production label → ChatModel resolver (C# `modelFactory` / `LlmRuntime`):
 * DeepSeek reads the API key from config then env AT REQUEST TIME (the adapter
 * throws MISSING_CREDENTIAL when it is blank — the CLI starts fine without a
 * key, exactly like C#); ChatGPT remains fail-closed until P8b.
 */
function defaultModelForLabel(modelLabel: string, effectiveProvider: string, config: DiConfig): ChatModel {
  const ref = ModelReference.parse(modelLabel, effectiveProvider, Object.keys(MODEL_CATALOG));
  if (ref.provider === "deepseek") {
    const apiKey = asString(config.get("deepseek:apikey"), "") || process.env.DEEPSEEK_API_KEY || "";
    return new DeepSeekAdapter({ model: ref.id, apiKey });
  }
  if (ref.provider === "chatgpt") {
    throw new Error("ChatGPT 尚未在 TypeScript 后端可用：P8b 宿主凭据存储被 Windows-ACL/lock 平台门槛阻塞。");
  }
  throw new Error(`未知 provider: ${ref.provider}`);
}

function providerName(id: string): string {
  if (id === "deepseek") return "DeepSeek";
  if (id === "chatgpt") return "ChatGPT";
  return id;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isBlank(value: string | undefined | null): value is undefined | null {
  if (value === undefined || value === null) return true;
  return value.trim().length === 0;
}
