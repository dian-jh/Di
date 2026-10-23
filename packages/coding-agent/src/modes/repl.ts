import type { AgentResult } from "@di/agent";
import { runInteractive as runInteractiveTui } from "di-tui";
import { LocalAgentRunnerAdapter } from "../adapters/tui-runner.ts";
import type { Skill } from "../core/skills/skill.ts";
import { LexicalSkillMatcher } from "../core/skills/skill-matcher.ts";
import { computeSkillActivation } from "../core/skills/skill-activation.ts";
import { SlashCommandRegistry } from "../core/commands/slash-command-registry.ts";
import type { CommandContext } from "../core/commands/command-context.ts";
import type { CliHost } from "../cli/cli-host.ts";
import type { TextReader, TextWriter } from "../cli/io.ts";
import { errorMessage } from "./common.ts";
import { drainEvents, EventRenderer, renderAll } from "./event-renderer.ts";
import { tryLaunchTui, type TuiDecision, type TuiLauncherContext } from "./tui-launcher.ts";

/*
 * Outer REPL loop (the counterpart ):
 * read a line → handle slash commands through the shared registry → run one
 * agent turn. Turn-type commands (/skill <name> <args>, user commands) are
 * executed by THIS REPL's own turn mechanism (the command definition never
 * depends on any frontend). Before each turn the shared skill activation is
 * recomputed (pinned set + auto-match), and the active skills are written to the
 * runner for that turn. A single `signal` cancels the whole session.
 */

/** REPL display configuration. */
export interface ReplOptions {
  /** Input prompt. */
  readonly prompt: string;
  /** "Working…" status line shown while waiting for the model's first output. */
  readonly workingStatusText: string;
  /** Whether ANSI control sequences (line clear) are allowed; false under redirect. */
  readonly useAnsi: boolean;
}

export const DEFAULT_REPL_OPTIONS: ReplOptions = {
  prompt: "di> ",
  workingStatusText: "⟳ 正在请求模型…",
  useAnsi: true,
};

export class Repl {
  private readonly host: CliHost;
  private readonly reader: TextReader;
  private readonly output: TextWriter;
  private readonly signal?: AbortSignal;
  private readonly options: ReplOptions;
  private readonly renderer: EventRenderer;
  /** Fixed (pinned) skills; auto-match results are recomputed per turn and never stored here. */
  private readonly pinned: Skill[] = [];

  constructor(host: CliHost, reader: TextReader, output: TextWriter, signal?: AbortSignal) {
    if (host == null) throw new TypeError("Repl: host is required");
    this.host = host;
    this.reader = reader;
    this.output = output;
    this.signal = signal;
    this.options = host.replOptions ?? DEFAULT_REPL_OPTIONS;
    this.renderer = new EventRenderer(output, this.options.useAnsi);
  }

  async run(): Promise<void> {
    for (const error of await this.host.models.refresh(this.signal)) this.output.writeLine(error);

    // 会话开始时写首行 session_meta（尽力而为：失败只告警，不阻塞 REPL）。
    try {
      this.host.sessionStore?.startSession();
    } catch (error) {
      this.output.writeLine(`  ⚠ 会话日志初始化失败: ${errorMessage(error)}`);
    }

    while (!(this.signal?.aborted ?? false)) {
      this.output.write(this.options.prompt);
      const line = await this.reader.readLine();
      if (line === null) break; // EOF

      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      if (trimmed.startsWith("/")) {
        if (await this.runCommand(trimmed)) break; // /exit
        continue;
      }
      await this.runTurn(trimmed);
    }
  }

  /**
   * One chat turn: create a consumer, run a concurrent render task, recompute the
   * skill activation, run the turn, then stop the renderer, drain stragglers and
   * render the final footnote.
   */
  private async runTurn(userMessage: string): Promise<void> {
    const consumer = this.host.bus.subscribe();
    const renderTask = renderAll(consumer, this.renderer);

    // 自动匹配：按本条消息与 skill 描述的语义相关度加载未固定的 skill（共享计算，headless 同款）。
    const activation = computeSkillActivation(userMessage, this.host.skills, this.pinned, new LexicalSkillMatcher());
    this.host.runner.setActiveSkills(activation.active);
    if (activation.autoMatched.length > 0) {
      this.output.writeLine("⟦ 自动加载 skill：" + activation.autoMatched.map((s) => s.name).join("、") + "⟧");
    }

    // 模型首个输出可能延迟数秒（网络/思考），先给出可见反馈，首个事件到达时被擦除。
    this.renderer.showStatus(this.options.workingStatusText);

    const startedAt = Date.now();
    let result: AgentResult;
    try {
      result = await this.host.runner.runTurn(userMessage, this.signal);
    } catch (error) {
      // 回合被取消（信号）/ 失败：清指示器、停渲染，提示后回到外层循环。
      this.renderer.clearStatus();
      this.output.writeLine(`  ✗ 运行失败: ${errorMessage(error)}`);
      this.host.bus.release(consumer);
      await renderTask;
      // 失败回合也落盘（尽力而为）：否则异常回合在会话文件里"查无此证"，无法复盘。
      try {
        this.host.sessionStore?.appendFailure(userMessage, errorMessage(error), startedAt);
      } catch (logError) {
        this.output.writeLine(`  ⚠ 会话日志写入失败: ${errorMessage(logError)}`);
      }
      return;
    }

    this.host.bus.release(consumer);
    await renderTask;
    drainEvents(consumer, this.renderer);
    this.renderer.renderResult(result);

    try {
      this.host.sessionStore?.appendTurn(result, startedAt);
    } catch (error) {
      this.output.writeLine(`  ⚠ 会话日志写入失败: ${errorMessage(error)}`);
    }
  }

  /**
   * Slash command dispatch (shared P6.3a registry: builtin + user commands);
   * returns true when the command requests session exit. A turn-type command is
   * executed by this REPL's turn mechanism.
   */
  private async runCommand(command: string): Promise<boolean> {
    const split = SlashCommandRegistry.split(command);
    const name = split.name.replace(/^\/+/, "");

    const cmd = this.host.commands.tryGet(name);
    if (cmd === undefined) {
      this.output.writeLine(`未知命令: /${name}（输入 /help 查看帮助）`);
      return false;
    }

    const context: CommandContext = {
      registry: this.host.commands,
      host: this.host.runner,
      skills: this.host.skills,
      output: this.output,
      pinned: this.pinned,
      useAnsi: this.options.useAnsi,
      runTurn: (message) => this.runTurn(message),
      models: this.host.models,
      ...(this.signal !== undefined ? { signal: this.signal } : {}),
    };

    const result = await cmd.handler(split.args, context);
    if (result.turnMessage !== undefined && result.turnMessage.length > 0) {
      await this.runTurn(result.turnMessage);
    }
    return result.exit;
  }
}

/**
 * Interactive orchestration ( evolution): default
 * hands the console to the TS TUI **in-process** — build the
 * {@link LocalAgentRunnerAdapter} and call di-tui's `runInteractive(adapter)`
 * (architecture.md §生产入口; DI direction coding-agent → di-tui). When the local
 * runner is unavailable (terminal not interactive / init failure) it falls back
 * to the legacy spawn TUI (external `--mode rpc` child) then the REPL.
 * `--resume` forces the REPL (`skipTui`) so a resumed session enters simple
 * interaction and does NOT auto-request a model (the REPL waits for user input);
 * `DI_UI=repl` (exact) forces the REPL.
 */
export async function runInteractive(
  host: CliHost,
  stdin: TextReader,
  stdout: TextWriter,
  stderr: TextWriter,
  stdinTty: boolean,
  stdoutTty: boolean,
  tui?: TuiLauncherContext,
  skipTui = false,
  signal?: AbortSignal,
): Promise<number> {
  if (stdinTty && stdoutTty && !skipTui) {
    const getEnv = tui?.getEnv ?? ((name: string) => process.env[name]);
    if (getEnv("DI_UI") === "repl") {
      stderr.writeLine("DI_UI=repl，使用 REPL");
    } else {
      // 生产交互默认：同进程 local runner（零子进程、零 RPC 编解码）。
      const local = await tryLaunchLocalTui(host);
      if (local.managed) return local.exitCode;
      if (local.fallbackReason !== undefined) stderr.writeLine(local.fallbackReason);
      // 回退：旧 spawn TUI（外部 RPC 子进程；tui/src/main.ts 保持独立 RPC launcher）。
      const decision = tryLaunchTui(tui);
      if (decision.managed) return decision.exitCode;
      if (decision.fallbackReason !== undefined) stderr.writeLine(decision.fallbackReason);
    }
  }

  const repl = new Repl(host, stdin, stdout, signal);
  await repl.run();
  return 0;
}

/**
 * Build the {@link LocalAgentRunnerAdapter} and hand it to di-tui's
 * `runInteractive(port)` (the P9 in-process runner wiring; DI direction
 * coding-agent → di-tui). Returns 0 when the TUI exits normally.
 */
export async function runInteractiveLocal(host: CliHost, options?: { readonly title?: string }): Promise<number> {
  if (host == null) throw new TypeError("runInteractiveLocal: host is required");
  const adapter = new LocalAgentRunnerAdapter(host);
  await runInteractiveTui(adapter, { ...(options?.title !== undefined ? { title: options.title } : {}) });
  return 0;
}

/**
 * Local-runner decision (the in-process analogue of `tryLaunchTui`): only when the
 * real process stdin/stdout are TTYs (the local TUI drives the terminal directly,
 * bypassing the injected TextReader/TextWriter seams); any failure is a managed=false
 * fallback reason, never a crash — the caller falls through to the legacy spawn TUI.
 */
export async function tryLaunchLocalTui(host: CliHost): Promise<TuiDecision> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { managed: false, exitCode: 0, fallbackReason: "终端非交互（stdin/stdout 非 TTY），回退旧 spawn TUI / REPL" };
  }
  try {
    await runInteractiveLocal(host);
    return { managed: true, exitCode: 0 };
  } catch (error) {
    return {
      managed: false,
      exitCode: 0,
      fallbackReason: `启动同进程 TUI 失败（${errorMessage(error)}），回退旧 spawn TUI / REPL`,
    };
  }
}
