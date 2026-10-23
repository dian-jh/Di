import type { SlashCommand } from "./slash-command.ts";

/*
 * Slash command registry (Pi's `SlashCommands` service): register / list /
 * resolve by name. Duplicate registration throws (unique names); `list`
 * returns the commands sorted by name for /help and the TUI command menu.
 *
 * (`StringComparer.Ordinal` == JS UTF-16 code-unit string ordering).
 */
export class SlashCommandRegistry {
  private readonly commands_ = new Map<string, SlashCommand>();

  /** Register one command; a duplicate name throws (unique names). */
  register(command: SlashCommand): void {
    if (command == null) throw new TypeError("SlashCommandRegistry.register: command is required");
    if (command.name.trim().length === 0) {
      throw new RangeError("SlashCommandRegistry.register: command name must not be blank");
    }
    if (this.commands_.has(command.name)) {
      throw new Error(`斜杠命令 /${command.name} 已注册`);
    }
    this.commands_.set(command.name, command);
  }

  registerAll(commands: Iterable<SlashCommand>): void {
    if (commands == null) throw new TypeError("SlashCommandRegistry.registerAll: commands is required");
    for (const command of commands) this.register(command);
  }

  /** All registered commands, sorted by name (Ordinal). */
  list(): readonly SlashCommand[] {
    return [...this.commands_.values()].sort((a, b) => ordinalCompare(a.name, b.name));
  }

  tryGet(name: string): SlashCommand | undefined {
    return this.commands_.get(name);
  }

  /**
   * Split one line of command input into (name incl. leading slash, args); no
   * space → empty args; args are trimmed on both sides.
   */
  static split(line: string): { name: string; args: string } {
    const space = line.indexOf(" ");
    if (space < 0) return { name: line, args: "" };
    return { name: line.slice(0, space), args: line.slice(space + 1).trim() };
  }

  /** Format one command (shared by /help and the list): `  /name [hint] —— description`. */
  static format(command: SlashCommand): string {
    return `  /${command.name}${command.argumentHint !== undefined ? " " + command.argumentHint : ""} —— ${command.description}`;
  }

  /** Derive the /help text from the registry (no hardcoding); builtin + user commands are listed uniformly. */
  buildHelp(): string {
    return "可用命令：\n" + this.list().map((c) => SlashCommandRegistry.format(c)).join("\n");
  }
}

/** Ordinal (UTF-16 code-unit) comparison —, NOT locale ordering. */
function ordinalCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
