import { readFile, stat } from "node:fs/promises";
import type { CoreTool } from "./types.ts";
import { errorObservation, okObservation } from "./types.ts";
import { getOptionalInt, getRequiredString, parseArguments, toolSchema } from "./args.ts";
import {
  createLegacyDecoder,
  decodeSmart,
  discoverOemCodePage,
  type LegacyDecoder,
} from "./encoding.ts";
import { isErrno, messageOf } from "./errors.ts";
import { resolvePath } from "./paths.ts";

/** Single-read size cap (1 MiB) so a giant file cannot exhaust context (MaxBytes). */
export const READ_FILE_MAX_BYTES = 1 << 20;
/** Max rendered lines per call; beyond this a continuation hint is emitted. */
export const READ_FILE_MAX_OUTPUT_LINES = 2000;
/** Max rendered characters per call (UTF-16 code units, matching string.Length). */
export const READ_FILE_MAX_OUTPUT_CHARS = 64 * 1024;

export interface ReadFileToolOptions {
  /** Override the 1 MiB file-size cap (host/test injection; ReadFileOptions.MaxBytes). */
  readonly maxBytes?: number;
  /** Override the system OEM code page used for non-UTF-8 files (undefined = auto-discover). */
  readonly oemCodePage?: number;
}

/*
 * read_file: UTF-8 text with line numbers, range reads, bounded output with a
 * continuation protocol..
 * Decoding follows: UTF-8 first (BOM stripped), then
 * OEM code page fallback, explicit decode error when no decoder exists.
 */
export function createReadFileTool(
  baseDirectory: string,
  options?: ReadFileToolOptions,
): CoreTool {
  const maxBytes = options?.maxBytes ?? READ_FILE_MAX_BYTES;
  return {
    spec: {
      name: "read_file",
      description:
        "读取文件内容，每行带行号前缀（便于后续用 edit_file 精确定位）。可用 start_line / end_line 读取指定行范围。输出超过 2000 行/64KB 会截断，并提示用 start_line 继续读取。文件超过 1MiB 会报错。",
      parameters: toolSchema(
        [["path", "string", "要读取的文件路径（相对工作区根目录）"]],
        [
          ["start_line", "integer", "可选：起始行号（从 1 开始）"],
          ["end_line", "integer", "可选：结束行号（含，默认到文件末尾）"],
        ],
      ),
    },
    promptSnippet: "读取文件内容，带行号，可用 start_line/end_line 读行范围",
    promptGuidelines: [
      "不确定内容时先读再动，不要凭猜",
      'read_file 提示"用 start_line=N 继续读取"时照做，直到读完为止',
    ],
    async execute(argumentsJson, signal) {
      signal?.throwIfAborted();

      const parsed = parseArguments(argumentsJson);
      if (!parsed.ok) return errorObservation(parsed.error);
      const pathResult = getRequiredString(parsed.value, "path");
      if (!pathResult.ok) return errorObservation(pathResult.error);
      const startResult = getOptionalInt(parsed.value, "start_line");
      if (!startResult.ok) return errorObservation(startResult.error);
      const endResult = getOptionalInt(parsed.value, "end_line");
      if (!endResult.ok) return errorObservation(endResult.error);

      const path = pathResult.value;
      const startLine = startResult.value;
      const endLine = endResult.value;
      let full: string;
      try {
        full = resolvePath(baseDirectory, path);
      } catch (error) {
        return errorObservation(`error: 路径参数非法: ${messageOf(error)}`);
      }
      signal?.throwIfAborted();

      let size: number;
      try {
        const info = await stat(full);
        if (info.isDirectory()) {
          return errorObservation(`error: 目标路径是目录，无法读取: ${path}`);
        }
        size = info.size;
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          return errorObservation(`error: 文件不存在: ${path}`);
        }
        return errorObservation(describeReadFailure(error));
      }
      signal?.throwIfAborted();

      if (size > maxBytes) {
        return errorObservation(
          `error: 文件过大（${size} 字节，上限 ${maxBytes} 字节），请用 start_line/end_line 分段读取`,
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = await readFile(full);
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          return errorObservation(`error: 文件不存在: ${path}`);
        }
        return errorObservation(describeReadFailure(error));
      }
      signal?.throwIfAborted();

      const decoded = await decodeSmart(bytes.subarray(stripBomLength(bytes)), () =>
        resolveOemDecoder(options),
      );
      if (!decoded.ok) return errorObservation(decoded.error);

      const lines = splitLines(decoded.text);
      if (lines.length === 0) return okObservation("");

      const start = startLine ?? 1;
      const end = Math.min(endLine ?? lines.length, lines.length);
      if (start < 1) {
        return errorObservation(`error: start_line 必须 ≥ 1（当前 ${start}）`);
      }
      if (end < start) {
        return errorObservation(`error: end_line（${end}）小于 start_line（${start}）`);
      }
      if (start > lines.length) {
        return errorObservation(`error: start_line（${start}）超出文件行数（${lines.length}）`);
      }

      const lineCappedEnd = Math.min(end, start + READ_FILE_MAX_OUTPUT_LINES - 1);
      const { text: rendered, shownEnd } = numberLines(
        lines,
        start - 1,
        lineCappedEnd,
        READ_FILE_MAX_OUTPUT_CHARS,
      );

      if (shownEnd < start) {
        return okObservation(
          `[第 ${start} 行超过 ${READ_FILE_MAX_OUTPUT_CHARS} 字符，无法用 read_file 展示。建议用 bash 分段处理，或换用其它方式]`,
        );
      }
      if (shownEnd < end) {
        return okObservation(
          `${rendered}\n\n[显示第 ${start}-${shownEnd} 行（共 ${lines.length} 行）。用 start_line=${shownEnd + 1} 继续读取]`,
        );
      }
      if (endLine !== undefined && end < lines.length) {
        return okObservation(
          `${rendered}\n\n[文件还有 ${lines.length - end} 行。用 start_line=${end + 1} 继续读取]`,
        );
      }
      return okObservation(rendered);
    },
  };
}

/** Resolve the OEM decoder for a non-UTF-8 file: explicit override or discovery. */
export async function resolveOemDecoder(options?: ReadFileToolOptions): Promise<LegacyDecoder | undefined> {
  const codePage = options?.oemCodePage ?? (await discoverOemCodePage());
  if (codePage === undefined) return undefined;
  if (codePage === 65001) return undefined; // OEM is UTF-8; strict already failed.
  return createLegacyDecoder(codePage);
}

function stripBomLength(bytes: Uint8Array): number {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
}

/** Classify read failures: invalid path argument vs IO. */
function describeReadFailure(error: unknown): string {
  if (isErrno(error, "ERR_INVALID_ARG_VALUE")) {
    return `error: 路径参数非法: ${messageOf(error)}`;
  }
  return `error: 读取失败: ${messageOf(error)}`;
}

/**
 * Split text into lines with .NET `File.ReadAllLines` semantics: `\r\n` / `\r` /
 * `\n` are line terminators, a trailing terminator adds no empty line, and an
 * empty file has zero lines.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "" && /(?:\n|\r)$/.test(text)) {
    parts.pop();
  }
  return parts;
}

/**
 * Render lines `from..to` (0-based from, 1-based exclusive `to`) as
 * `"<n>: <line>"` separated by `\n`, honoring a character budget at line
 * boundaries (never a partial line). Returns the last rendered 1-based line
 * number in `shownEnd`. Port of `ReadFileTool.Number`.
 */
function numberLines(
  lines: readonly string[],
  from: number,
  to: number,
  maxChars: number,
): { text: string; shownEnd: number } {
  let text = "";
  let chars = 0;
  let i = from;
  for (; i < to; i += 1) {
    const line = `${i + 1}: ${lines[i]}\n`;
    if (chars + line.length > maxChars) break;
    text += line;
    chars += line.length;
  }
  return { text: text.length === 0 ? "" : text.slice(0, -1), shownEnd: i };
}
