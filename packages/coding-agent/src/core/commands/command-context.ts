import type { Skill } from "../skills/skill.ts";
import type { ModelSelection } from "../model-selection.ts";
import type { SlashCommandRegistry } from "./slash-command-registry.ts";

/*
 * Command invocation context: capabilities (registry / skills / output / pinned
 * / models) plus host-injected turn executor and display switch. `pinned` is a
 * mutable fixed set owned by the caller (REPL and RPC each hold their own
 * instance); it persists across commands and is read/written by /skill and
 * /skills. /help derives the help text from `registry`. REPL provides
 * `runTurn` (turn-based commands run through it); RPC passes none and maps a
 * Turn result to `turn_not_supported` (docs/tui-rpc.md §2.5) — never silently
 * opening a second turn.
 *.
 */

/** The host capabilities commands need (the `IAgentRunner` surface). */
export interface CommandHost {
  /** Current model reference (`runner.CurrentModel`). */
  readonly currentModel: string;
  /** Clear screen + conversation memory (`runner.ResetHistory`). */
  resetHistory(): void;
  /** Replace the active skill set (`runner.ActiveSkills =...`). */
  setActiveSkills(skills: readonly Skill[]): void;
}

/** Command output sink (`TextWriter`; buffered in tests / mode wiring). */
export interface CommandOutput {
  /** Write raw text without a trailing newline (ANSI clear screen). */
  write(text: string): void;
  /** Write text + a trailing newline. */
  writeLine(text?: string): void;
}

/** Simple in-memory {@link CommandOutput} (`StringWriter`). */
export class StringCommandOutput implements CommandOutput {
  private buffer_ = "";

  write(text: string): void {
    this.buffer_ += text;
  }

  writeLine(text: string = ""): void {
    this.buffer_ += text + "\n";
  }

  /** The accumulated text. */
  toString(): string {
    return this.buffer_;
  }
}

export interface CommandContext {
  readonly registry: SlashCommandRegistry;
  readonly host: CommandHost;
  /** The available skills (from the skill repository; /skills and /skill read it). */
  readonly skills: readonly Skill[];
  /** Mutable fixed (pinned) set owned by the caller; persists across commands. */
  readonly pinned: Skill[];
  readonly output: CommandOutput;
  /** Default true (record default); ANSI clear screen is omitted under redirect / RPC. */
  readonly useAnsi?: boolean;
  /** Host-injected turn executor (REPL). Absent in RPC: a Turn result maps to turn_not_supported. */
  readonly runTurn?: (message: string) => void | Promise<void>;
  readonly models?: ModelSelection;
  readonly signal?: AbortSignal;
}
