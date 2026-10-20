import { existsSync } from "node:fs";
import { homedir } from "node:os";

import { DEFAULT_CONFIG, DiConfig, defaultReadFile } from "../core/config/di-config.ts";
import { DiHome } from "../core/config/di-home.ts";
import { aggregateSessionStats, type SessionStatsSummary } from "../core/sessions/session-stats.ts";
import { LexicalSkillMatcher } from "../core/skills/skill-matcher.ts";
import { loadSkillCases, type SkillTestCase } from "../core/skills/skill-case-loader.ts";
import { evaluateSkillSet } from "../core/skills/skill-evaluator.ts";
import { CliArgsParser, type CliArgs } from "./args.ts";
import { CliMode, AppMode } from "./mode.ts";
import { CliInfo } from "./cli-info.ts";
import { type CliHost, type CliHostFactory, defaultCliHostFactory } from "./cli-host.ts";
import { type TextReader, type TextWriter } from "./io.ts";
import { runAuthCommand } from "./auth-command.ts";

/**
 * CLI dispatch shell (Pi's main.ts counterpart; C# `Di.Cli/CliApp.cs` at baseline
 * 09f4e08): parse args → validate → resolve mode → build host → dispatch. It
 * never touches the console — input/output streams and TTY detection are injected
 * — so the shell is replayable in any host and testable with in-memory streams.
 *
 * Short paths (--version / --info / --help / --stats and argument errors) return
 * before any host is built. Host-requiring paths (--list-models / --skill-eval)
 * go through the injected {@link CliHostFactory}; a throwing factory becomes the
 * documented host-failure output (json mode → a single error doc on stdout,
 * text modes → stderr). The interactive / print / json / rpc BODIES are P6.3c:
 * the host is built (the seam the bodies slot into) and the mode then fails
 * closed with an honest "not yet implemented" message.
 *
 * Output contract (docs/cli.md §3.4/§4): data → stdout, diagnostics/errors →
 * stderr, exit code 0 = success / 1 = usage or runtime error, ANSI only when
 * `stdoutTty && !noAnsi`. Internal camelCase never leaks to the wire: the
 * JSON/RPC wire shapes are produced by the P6.3c mode bodies.
 */

/** Fallback effective-config values mirror the C# `AgentLoopOptions` / `ModelOptions` defaults. */
const AGENT_LOOP_DEFAULTS = { maxIterations: 0, historyBudgetRatio: 0.5 };
const MODEL_DEFAULTS = { provider: "deepseek", defaultModel: "deepseek-flash" };

export class CliApp {
  private readonly hostFactory: CliHostFactory;

  constructor(hostFactory: CliHostFactory = defaultCliHostFactory) {
    this.hostFactory = hostFactory;
  }

  /** Run one CLI invocation and return the process exit code (0 = success, 1 = usage/runtime error). */
  async runAsync(
    args: readonly string[],
    stdin: TextReader,
    stdout: TextWriter,
    stderr: TextWriter,
    stdinTty: boolean,
    stdoutTty: boolean,
  ): Promise<number> {
    if (args[0] === "auth") return runAuthCommand(args, stdout, stderr);

    const { args: cliArgs, diagnostics } = CliArgsParser.parse(args);
    if (diagnostics.some((d) => d.isError)) {
      for (const diagnostic of diagnostics) stderr.writeLine(diagnostic.message);
      stderr.writeLine("用法: di [选项] [提示词]（--help 查看完整帮助）");
      return 1;
    }

    const mode = CliMode.resolve(cliArgs, stdinTty, stdoutTty);
    const workspace = process.cwd();
    const useAnsi = stdoutTty && !cliArgs.noAnsi;

    switch (mode) {
      case AppMode.Version:
        stdout.writeLine(CliInfo.version);
        return 0;

      case AppMode.Info:
        return await info(cliArgs, workspace, stdout, process.env);

      case AppMode.Help:
        stdout.write(CliInfo.helpText);
        return 0;

      case AppMode.Stats:
        return stats(cliArgs.stats, stdout, stderr);

      default: {
        // Host-required paths: build the composition root, then dispatch.
        let host: CliHost;
        try {
          host = this.hostFactory(cliArgs, workspace, stderr, useAnsi);
        } catch (error) {
          if (cliArgs.mode === "json") {
            stdout.writeLine(JSON.stringify({ error: { code: "session_resume", message: errorMessage(error) } }));
          } else {
            stderr.writeLine(`无法启动 CLI：${errorMessage(error)}`);
          }
          return 1;
        }
        switch (mode) {
          case AppMode.ListModels:
            return await listModels(host, cliArgs.listModels ?? "", stdout, stderr);
          case AppMode.SkillEval:
            return await skillEval(host, cliArgs.skillEval, stdout, stderr);
          default:
            return deferredMode(mode, stderr);
        }
      }
    }
  }
}

/**
 * Print environment / effective-config info (short path, no host): the version,
 * runtime, config sources and the effective MaxIterations / model / provider with
 * CLI override annotations — the "is my installed binary stale" diagnostic.
 */
async function info(args: CliArgs, workspace: string, stdout: TextWriter, env: NodeJS.ProcessEnv): Promise<number> {
  const diHome = DiHome.fromEnvironment(env, homedir());
  const config = await DiConfig.load(
    {
      defaults: DEFAULT_CONFIG,
      userConfigPath: diHome.configFile,
      projectConfigPath: DiHome.projectConfigFile(workspace),
      env,
    },
    { readFile: defaultReadFile },
  );

  const maxIterationsConfigured = config.get("agentloop:maxiterations");
  const maxIterations = asNumber(maxIterationsConfigured, AGENT_LOOP_DEFAULTS.maxIterations);
  const historyBudgetRatio = asNumber(config.get("agentloop:historybudgetratio"), AGENT_LOOP_DEFAULTS.historyBudgetRatio);
  const reasoningEffort = asOptionalString(config.get("agentloop:reasoningeffort"));
  const modelProvider = asString(config.get("model:provider"), MODEL_DEFAULTS.provider);
  const modelDefaultModel = asString(config.get("model:defaultmodel"), MODEL_DEFAULTS.defaultModel);

  const effectiveProvider = !isBlank(args.provider) ? args.provider : modelProvider;
  const effectiveModel = !isBlank(args.model) ? args.model : modelDefaultModel;
  const diHomeEnv = env[DiHome.envVariableName];

  stdout.writeLine("di —— 简洁的 ReAct 编码助手（harness）");
  stdout.writeLine(`版本:        ${CliInfo.version}`);
  stdout.writeLine(`运行时:      Node.js ${process.version}（${osName()}）`);
  stdout.writeLine(`可执行文件:  ${process.execPath}`);
  stdout.writeLine(`工作区:      ${workspace}`);
  stdout.writeLine(`Di 家目录:   ${diHome.rootDirectory}`);
  stdout.writeLine(`Shell 工具:  ${platformShellName()}  （Windows 用 cmd.exe，其他平台用 bash）`);
  stdout.writeLine();
  stdout.writeLine("配置源（后加载覆盖先加载）:");
  stdout.writeLine(`  内置默认值                        （随包分发，内置 appsettings 等价物）`);
  stdout.writeLine(`  用户 ~/.di/config.json            ${diHome.configFile}` + (existsSync(diHome.configFile) ? "  存在" : "  不存在"));
  stdout.writeLine(`  项目 <workspace>/.di/config.json  ${DiHome.projectConfigFile(workspace)}` + (existsSync(DiHome.projectConfigFile(workspace)) ? "  存在" : "  不存在"));
  stdout.writeLine(`  环境变量 DI_HOME                  ${isBlank(diHomeEnv) ? "（未设置）" : diHomeEnv}`);
  stdout.writeLine();
  stdout.writeLine("生效配置（含命令行覆盖）:");
  stdout.writeLine(`  AgentLoop:MaxIterations     ${maxIterations}  ${maxIterationsConfigured === undefined ? "（来源: 默认值）" : "（来源: 配置显式覆盖）"}`);
  stdout.writeLine(`  AgentLoop:HistoryBudgetRatio ${historyBudgetRatio.toFixed(2)}`);
  stdout.writeLine(
    `  AgentLoop:ReasoningEffort   ${isBlank(reasoningEffort) ? "未设置" : reasoningEffort}` +
      (isBlank(args.thinking) ? "" : `   ← --thinking 覆盖为 ${args.thinking}`),
  );
  stdout.writeLine(`  Model:Provider              ${effectiveProvider}` + (isBlank(args.provider) ? "" : "   ← --provider 覆盖"));
  stdout.writeLine(`  Model:DefaultModel          ${effectiveModel}` + (isBlank(args.model) ? "" : "   ← --model 覆盖"));
  return 0;
}

/** Aggregate one session JSONL (offline, no host): turns / tokens / cache hit rate / cost. */
function stats(path: string | undefined, stdout: TextWriter, stderr: TextWriter): number {
  if (isBlank(path)) {
    stderr.writeLine("用法: di --stats <会话.jsonl>");
    return 1;
  }
  if (!existsSync(path)) {
    stderr.writeLine(`✗ 会话文件不存在: ${path}`);
    return 1;
  }

  let summary: SessionStatsSummary;
  try {
    summary = aggregateSessionStats(path);
  } catch (error) {
    stderr.writeLine(`✗ 无法解析会话文件: ${errorMessage(error)}`);
    return 1;
  }
  if (summary.turns === 0) {
    stderr.writeLine("✗ 未找到任何 task_complete 记录（这不是一次有效会话）");
    return 1;
  }

  stdout.writeLine(`回合数: ${summary.turns}`);
  stdout.writeLine(`输入 token: ${summary.inputTokens}（缓存命中 ${summary.cacheReadTokens}，命中率 ${formatP1(summary.cacheHitRate)}）`);
  stdout.writeLine(`输出 token: ${summary.outputTokens}`);
  if (summary.totalCost !== undefined) stdout.writeLine(`总成本: $${summary.totalCost.toFixed(4)}`);
  return 0;
}

/** List the model catalog (advisory, best-effort); an optional pattern filters by id/provider substring. */
async function listModels(host: CliHost, pattern: string, stdout: TextWriter, stderr: TextWriter): Promise<number> {
  for (const error of await host.models.refresh()) stderr.writeLine(error);
  let models = host.models.list();
  if (!isBlank(pattern)) {
    const q = pattern.toLowerCase();
    models = models.filter((m) => m.id.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q));
  }
  const sorted = [...models].sort((a, b) => {
    const byProvider = ordinalCompare(a.provider, b.provider);
    return byProvider !== 0 ? byProvider : ordinalCompare(a.id, b.id);
  });
  for (const model of sorted) stdout.writeLine(`${model.provider}/${model.id}  ${model.name}`);
  if (sorted.length === 0) stdout.writeLine("（无可用模型 —— 检查 provider 配置与网络）");
  return 0;
}

/** Evaluate the skill matcher on a labeled case set; depends on the host's discovered skills. */
async function skillEval(host: CliHost, casesPath: string | undefined, stdout: TextWriter, stderr: TextWriter): Promise<number> {
  if (isBlank(casesPath)) {
    stderr.writeLine("用法: di --skill-eval <cases.json>");
    return 1;
  }

  let cases: readonly SkillTestCase[];
  try {
    cases = loadSkillCases(casesPath, (msg) => stderr.writeLine(`  ⚠ ${msg}`));
  } catch (error) {
    stderr.writeLine(`✗ 无法加载用例文件: ${errorMessage(error)}`);
    return 1;
  }
  if (cases.length === 0) {
    stderr.writeLine("✗ 用例文件为空（全部条目被跳过）");
    return 1;
  }

  const metrics = evaluateSkillSet(new LexicalSkillMatcher(), host.skills, cases);
  stdout.writeLine(`用例数: ${cases.length}`);
  stdout.writeLine(`精确率: ${metrics.precision.toFixed(3)}`);
  stdout.writeLine(`召回率: ${metrics.recall.toFixed(3)}`);
  stdout.writeLine(`无匹配率: ${metrics.noMatchRate.toFixed(3)}`);
  stdout.writeLine(`平均上下文 token/回合: ${metrics.averageContextTokens.toFixed(0)}`);
  return 0;
}

/**
 * Interactive / print / json / rpc mode BODY seam. Resolution already happened;
 * the bodies are P6.3c (REPL / PrintMode / JSON single-doc / RPC NDJSON + busy
 * envelope). Fail closed with an honest message so nothing silently "succeeds".
 */
function deferredMode(mode: AppMode, stderr: TextWriter): number {
  stderr.writeLine(`${mode} 模式尚未在 TypeScript 后端实现（P6.3c 接线）。`);
  return 1;
}

function osName(): string {
  switch (process.platform) {
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    case "darwin":
      return "macOS";
    default:
      return process.platform;
  }
}

function platformShellName(): string {
  return process.platform === "win32" ? "cmd" : "bash";
}

/** Ordinal (UTF-16 code-unit) comparison — C# `StringComparer.Ordinal`, NOT locale. */
function ordinalCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** .NET `P1` percent format: `0.9 → "90.0%"`; null → "" (C# `double?.ToString("P1")`). */
function formatP1(rate: number | undefined): string {
  if (rate === undefined) return "";
  return `${(rate * 100).toFixed(1)}%`;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Blank check as a type guard so callers are narrowed to a non-blank string after the early return. */
function isBlank(value: string | undefined | null): value is undefined | null {
  if (value === undefined || value === null) return true;
  return value.trim().length === 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
