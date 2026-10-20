import type { CommandContext } from "./command-context.ts";

/**
 * Slash command vocabulary: the handler delegate, the contribution record and
 * the execution result. Mirrors `Di.Cli/Commands/SlashCommand.cs` and
 * `Di.Cli/Commands/CommandResult.cs` at baseline 09f4e08 — builtin and user
 * commands (`~/.di/commands/<name>.md`) are registered into one
 * {@link SlashCommandRegistry}, and both frontends (REPL and RPC/TUI) share the
 * same registry and handlers (Pi's `SlashCommandContribution`: name /
 * description / argumentHint / run).
 */

/** Slash command handler: args + context → execution result. */
export type SlashCommandHandler = (
  args: string,
  ctx: CommandContext,
) => CommandResult | Promise<CommandResult>;

/** One slash-command contribution: metadata + handler. */
export interface SlashCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly handler: SlashCommandHandler;
}

/**
 * Command execution result (Pi's `AgentOperationResponse` semantics): whether the
 * command produced a turn — a synchronous reply (`HANDLED` / `QUIT`) or a
 * request for the host to run one turn (`turnCommand`). The host (REPL / RPC)
 * executes a Turn with its own turn mechanism; the command definition itself
 * never depends on any frontend.
 */
export interface CommandResult {
  /** Command requests session exit (/exit). */
  readonly exit: boolean;
  /** When set, the command requests the host to run a turn with this message. */
  readonly turnMessage?: string;
}

/** Command handled, no turn. */
export const HANDLED: CommandResult = Object.freeze({ exit: false });

/** Command requests session exit (/exit). */
export const QUIT: CommandResult = Object.freeze({ exit: true });

/** Command requests the host to run a turn (/skill <name> <args>, user commands). */
export function turnCommand(message: string): CommandResult {
  return { exit: false, turnMessage: message };
}
