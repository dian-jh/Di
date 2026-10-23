import { basename, join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { SlashCommandRegistry } from "./slash-command-registry.ts";
import { CommandFormatException, parseCommandMarkdown } from "./command-markdown.ts";
import { turnCommand } from "./slash-command.ts";

/*
 * Load user slash commands from `~/.di/commands/*.md` (flat files; command name
 * = file name).
 * — the skills "bad file never blocks startup" rule: invalid files warn
 * and skip; name collisions with existing commands warn and skip (first
 * registered wins). User commands are turn-based: the body template + the
 * invocation args ask the host to run a full turn (MVP does no `$1` placeholder
 * substitution).
 */
export function loadCommandsInto(
  registry: SlashCommandRegistry,
  commandsDirectory: string,
  warn?: (message: string) => void,
): number {
  if (registry == null) throw new TypeError("loadCommandsInto: registry is required");
  if (!isDirectory(commandsDirectory)) return 0;

  const files = readdirSync(commandsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isMarkdownFile(entry.name))
    .map((entry) => entry.name)
    .sort();

  let loaded = 0;
  for (const fileName of files) {
    const file = join(commandsDirectory, fileName);
    const name = basename(file, ".md");

    if (registry.tryGet(name) !== undefined) {
      warn?.(`跳过命令 /${name}：与既有命令重名（${file}）`);
      continue;
    }

    try {
      const cmd = parseCommandMarkdown(readFileSync(file, "utf8"), name);
      registry.register({
        name: cmd.name,
        description: cmd.description,
        ...(cmd.argumentHint !== undefined ? { argumentHint: cmd.argumentHint } : {}),
        handler: (args) => Promise.resolve(turnCommand(composeMessage(cmd.body, args))),
      });
      loaded += 1;
    } catch (error) {
      if (isSkippableError(error)) {
        warn?.(`跳过无效命令 ${file}: ${errorMessage(error)}`);
      } else {
        throw error;
      }
    }
  }
  return loaded;
}

/** Instruction template + args: with args they are appended to the body (MVP: no placeholder substitution). */
function composeMessage(body: string, args: string): string {
  return args.length === 0 ? body : `${body}\n\n${args}`;
}

/** `<dir>` exists and is a directory ( returns false for files). */
function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Windows `.md` suffix is case-insensitive (mirrors ). */
function isMarkdownFile(name: string): boolean {
  return process.platform === "win32" ? /\.md$/i.test(name) : name.endsWith(".md");
}

/** Skip range mirrors: CommandFormatException + filesystem errors (IOException/UnauthorizedAccess). */
function isSkippableError(error: unknown): boolean {
  if (error instanceof CommandFormatException) return true;
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
