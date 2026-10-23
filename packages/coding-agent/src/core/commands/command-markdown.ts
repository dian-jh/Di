/*
 * User-command Markdown parsing (`~/.di/commands/<name>.md`): `---`-wrapped
 * frontmatter + a body instruction template. * — frontmatter only
 * carries display metadata (`description` required, `argument-hint` optional);
 * the command name IS the file name (frontmatter declares no name). The body is
 * the instruction template; invocation appends args and runs a full turn (the
 * loader wraps it into a turn-based command). Strictness `SkillMarkdown`:
 * recognized fields may appear only once, unknown fields are ignored, BOM/CRLF
 * tolerated.
 */

/** User command file format error (frontmatter missing / description missing / empty body). */
export class CommandFormatException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandFormatException";
  }
}

export const MAX_COMMAND_NAME_LENGTH = 64;
export const MAX_COMMAND_DESCRIPTION_LENGTH = 1024;

const VALID_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Parsed user command (name = file name; body is the instruction template). */
export interface UserCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly body: string;
}

/** Parse one command file's content; `expectedName` = the file name (command name, must be valid). */
export function parseCommandMarkdown(content: string, expectedName: string): UserCommand {
  if (content == null) throw new TypeError("parseCommandMarkdown: content is required");
  if (expectedName == null) throw new TypeError("parseCommandMarkdown: expectedName is required");
  if (!isValidName(expectedName)) {
    throw new CommandFormatException(
      `命令名 '${expectedName}' 非法：仅限小写字母/数字/连字符，≤${MAX_COMMAND_NAME_LENGTH} 字符（命令名 = 文件名）。`,
    );
  }

  content = trimStartChars(content, "﻿", "\r", "\n");
  const firstLineEnd = content.indexOf("\n");
  const firstLine = firstLineEnd < 0 ? content : content.slice(0, firstLineEnd);
  if (trimTrailingCr(firstLine) !== "---") {
    throw new CommandFormatException("命令文件必须以 '---' 开头（YAML frontmatter）。");
  }

  const end = findFrontmatterEnd(content, firstLineEnd + 1);
  if (end < 0) throw new CommandFormatException("未找到 frontmatter 的结束行 '---'。");

  const frontmatter = content.slice(firstLineEnd + 1, end);
  let description: string | undefined;
  let argumentHint: string | undefined;
  const seen = new Set<string>(); // recognized-field occurrence set → duplicate rejects

  for (const rawLine of frontmatter.split("\n")) {
    const line = trimTrailingCr(rawLine);
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue; // empty / YAML comment
    const colon = line.indexOf(":");
    if (colon <= 0) continue; // ignore unparseable lines
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^["']+|["']+$/g, ""); // Trim().Trim('"', '\'')

    if (key !== "description" && key !== "argument-hint") continue; // unknown fields ignored (forward compat)
    if (seen.has(key)) throw new CommandFormatException(`frontmatter 字段 '${key}' 重复出现。`);
    seen.add(key);
    if (key === "description") description = value;
    else argumentHint = value;
  }

  if (description === undefined || description.trim().length === 0) {
    throw new CommandFormatException("frontmatter 缺少 description。");
  }
  if (description.length > MAX_COMMAND_DESCRIPTION_LENGTH) {
    throw new CommandFormatException(`description 超过 ${MAX_COMMAND_DESCRIPTION_LENGTH} 字符（当前 ${description.length}）。`);
  }

  const body = content.slice(end).replace(/^[\r\n]+/, "").trim();
  if (body.length === 0) throw new CommandFormatException("命令文件正文为空（需要指令模板）。");

  return {
    name: expectedName,
    description,
    ...(argumentHint !== undefined ? { argumentHint } : {}),
    body,
  };
}

/**
 * From `start`, find a standalone "---" line; return the index just past that
 * line's content (not including its newline), or -1 when not found.
 */
function findFrontmatterEnd(content: string, start: number): number {
  let pos = start;
  while (pos <= content.length) {
    const nl = content.indexOf("\n", pos);
    const lineEnd = nl < 0 ? content.length : nl;
    if (trimTrailingCr(content.slice(pos, lineEnd)) === "---") return lineEnd;
    if (nl < 0) return -1;
    pos = nl + 1;
  }
  return -1;
}

function isValidName(name: string): boolean {
  return name.length <= MAX_COMMAND_NAME_LENGTH && VALID_NAME_PATTERN.test(name);
}

/** Remove every leading occurrence of any of `chars`. */
function trimStartChars(text: string, ...chars: string[]): string {
  let i = 0;
  while (i < text.length && chars.includes(text[i]!)) i += 1;
  return text.slice(i);
}

/** Remove every trailing '\r'. */
function trimTrailingCr(text: string): string {
  return text.replace(/\r+$/g, "");
}
