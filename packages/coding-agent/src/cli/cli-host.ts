import type { AgentResult } from "@di/agent";
import type { Skill } from "../core/skills/skill.ts";
import type { ModelSelection } from "../core/model-selection.ts";
import type { SlashCommandRegistry } from "../core/commands/slash-command-registry.ts";
import type { SessionStore } from "../core/sessions/session-log.ts";
import type { EventBus } from "../core/events/event-bus.ts";
import type { ReplOptions } from "../modes/repl.ts";
import type { CliArgs } from "./args.ts";
import type { TextWriter } from "./io.ts";
import { createCliHost } from "./cli-host-compose.ts";

/**
 * CLI host seam (the composition root; C# `Di.Cli/CliHost.cs` at baseline
 * 09f4e08). P6.3b exposed models + skills for list-models / skill-eval; P6.3c
 * adds the mode seams the interactive / print / json / rpc bodies drive: the
 * session-turn runner, the AgentLoopEvent bus, the shared slash-command registry,
 * the optional session store, the reasoning-effort snapshot and the REPL display
 * options. The factory is injected so the dispatch shell never builds DI itself.
 */

/**
 * The session-turn runner seam the modes drive (C# `IAgentRunner` subset):
 * current model label read-write, history reset, active-skill replacement and one
 * turn. `AgentSession` (P5) is the real implementation surface; the composition
 * root bridges it through {@link createSessionRunner} (P7 wiring).
 */
export interface TurnRunner {
  /** Current model label (C# `runner.CurrentModel`; `ModelSelection` reads/writes it). */
  readonly currentModel: string;
  /** Commit a model label (P7 bridges the label to the session's ChatModel). */
  setCurrentModel(model: string): void;
  /** Clear screen + conversation memory (C# `runner.ResetHistory()`). */
  resetHistory(): void;
  /** Replace the active skill set (translates to the session's volatile request tail). */
  setActiveSkills(skills: readonly Skill[]): void;
  /** Run one turn (C# `IAgentRunner.RunAsync`; `AgentSession.runTurn`). */
  runTurn(userMessage: string, signal?: AbortSignal): Promise<AgentResult>;
}

export interface CliHost {
  /** Model selection: advisory catalog + provider/model resolution (--list-models, /model). */
  readonly models: ModelSelection;
  /** Skills discovered by the host (skill-eval / auto-activation use the production-identical set). */
  readonly skills: readonly Skill[];
  /** Session-turn runner (AgentSession-backed; the interactive / print / json / rpc bodies drive it). */
  readonly runner: TurnRunner;
  /** AgentLoopEvent bus (modes subscribe before a turn; the session's events feed it). */
  readonly bus: EventBus;
  /** Slash-command registry (builtin + user commands; REPL and RPC share the same set). */
  readonly commands: SlashCommandRegistry;
  /** Durable session store; absent = no session log (--no-session). */
  readonly sessionStore?: SessionStore;
  /** Current reasoning effort snapshot (ready handshake / command_ran; null/absent = none). */
  readonly reasoningEffort?: string | null;
  /** REPL display configuration (output redirect sets UseAnsi false). */
  readonly replOptions?: ReplOptions;
  /**
   * Dispose chain (C# `CliHost.IDisposable`): writes `di exiting`, closes the
   * DiLog file, clears the ProcessDiagnostics hook. The dispatch shell calls it
   * after the mode body; idempotent.
   */
  readonly dispose?: () => void;
}

/**
 * Host factory (C# `Func<CliArgs, string, TextWriter, bool, CliHost>`): called
 * with the parsed args, the current workspace, a stderr writer for construction
 * warnings and the ANSI decision (`stdoutTty && !noAnsi`). A throwing factory is
 * turned into the documented host-failure output (json → stdout error envelope,
 * text modes → stderr) by the dispatch shell. The `--resume` recovery
 * (loadRecovery → `AgentSession.restoreHistory`) belongs HERE — a recovery
 * failure throws and becomes the host-failure envelope; it must never fake an
 * empty session.
 */
export type CliHostFactory = (
  args: CliArgs,
  workspace: string,
  stderr: TextWriter,
  useAnsi: boolean,
) => CliHost | Promise<CliHost>;

/**
 * Default host factory — the REAL composition root (P7a): AgentSession + tools +
 * skills + sessionStore + DiLog + createSessionRunner, with `--resume` recovery
 * and the P6.4 emission seams. It is async (layered config load); the dispatch
 * shell awaits it and turns a thrown/rejected factory into the documented
 * host-failure envelope. Injected factories replace it in tests / embedded hosts.
 */
export const defaultCliHostFactory: CliHostFactory = createCliHost;
