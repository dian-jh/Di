import { readFile, writeFile } from "node:fs/promises";
import type { CoreTool } from "./types.ts";
import { errorObservation, okObservation } from "./types.ts";
import { getContent, getRequiredString, parseArguments, toolSchema } from "./args.ts";
import { isErrno, messageOf } from "./errors.ts";
import { resolvePath } from "./paths.ts";

/*
 * edit_file: old_string -> new_string replacement, applied only when old_string
 * exists and occurs exactly once (no fuzzy replacement; overlapping occurrences
 * count as ambiguous)..
 *
 * Matching happens in LF-normalized space (read_file emits LF lines, so an LF
 * old_string hits a CRLF file), and the file's CRLF/LF style plus UTF-8 BOM are
 * restored on write-back. A failed edit never changes the file.
 */
export function createEditFileTool(baseDirectory: string): CoreTool {
  return {
    spec: {
      name: "edit_file",
      description:
        "替换文件中唯一的一处 old_string。old_string 必须存在且只出现一次，否则报错（不会模糊替换）。替换大段内容时请带上足够的上下文使匹配唯一。",
      parameters: toolSchema([
        ["path", "string", "要编辑的文件路径（相对工作区根目录）"],
        ["old_string", "string", "要替换的原文（必须在文件中出现且只出现一次）"],
        ["new_string", "string", "替换后的新文本"],
      ]),
    },
    promptSnippet: "精准替换：把文件中唯一出现的 old_string 替换为 new_string",
    promptGuidelines: [
      "修改文件优先 edit_file（old_string 必须唯一，报错时提供更多上下文使其唯一），整体重写才用 write_file",
    ],
    async execute(argumentsJson, signal) {
      signal?.throwIfAborted();

      const parsed = parseArguments(argumentsJson);
      if (!parsed.ok) return errorObservation(parsed.error);
      const pathResult = getRequiredString(parsed.value, "path");
      if (!pathResult.ok) return errorObservation(pathResult.error);
      const oldResult = getRequiredString(parsed.value, "old_string");
      if (!oldResult.ok) return errorObservation(oldResult.error);
      const newResult = getContent(parsed.value, "new_string");
      if (!newResult.ok) return errorObservation(newResult.error);

      const path = pathResult.value;
      const oldString = oldResult.value;
      let full: string;
      try {
        full = resolvePath(baseDirectory, path);
      } catch (error) {
        return errorObservation(`error: 路径参数非法: ${messageOf(error)}`);
      }
      signal?.throwIfAborted();

      let bytes: Uint8Array;
      try {
        bytes = await readFile(full);
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          return errorObservation(`error: 文件不存在: ${path}`);
        }
        if (isErrno(error, "ERR_INVALID_ARG_VALUE")) {
          return errorObservation(`error: 路径参数非法: ${messageOf(error)}`);
        }
        return errorObservation(`error: 读取失败: ${messageOf(error)}`);
      }
      signal?.throwIfAborted();

      const { content, bom } = decodeUtf8WithBom(bytes);
      const ending = detectLineEnding(content);
      const normalized = normalizeToLf(content);
      const normalizedOld = normalizeToLf(oldString);

      const first = normalized.indexOf(normalizedOld);
      if (first < 0) {
        return errorObservation("error: 在文件中未找到 old_string");
      }
      // Search from first + 1 so overlapping occurrences ("aa" in "aaa") also
      // count as ambiguous — never silently replace the first match.
      const second = normalized.indexOf(normalizedOld, first + 1);
      if (second >= 0) {
        return errorObservation("error: old_string 在文件中出现多次，请提供更多上下文使其唯一");
      }

      const newTextLf =
        normalized.slice(0, first) +
        normalizeToLf(newResult.value) +
        normalized.slice(first + normalizedOld.length);
      const finalText = bom + (ending === "\r\n" ? newTextLf.replace(/\n/g, "\r\n") : newTextLf);
      try {
        await writeFile(full, finalText, "utf8");
      } catch (error) {
        return errorObservation(`error: 写入失败: ${messageOf(error)}`);
      }
      return okObservation(
        `OK: 已替换（${countLines(oldString)} 行 → ${countLines(newResult.value)} 行）`,
      );
    },
  };
}

/** UTF-8 decode with BOM stripped; the BOM is returned for faithful write-back. */
function decodeUtf8WithBom(bytes: Uint8Array): { content: string; bom: string } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { bom: "﻿", content: new TextDecoder("utf-8").decode(bytes.subarray(3)) };
  }
  return { bom: "", content: new TextDecoder("utf-8").decode(bytes) };
}

/** Detect the file's line-ending style by the first newline (DetectLineEnding). */
function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  if (lf < 0 || crlf < 0) return "\n";
  return crlf < lf ? "\r\n" : "\n";
}

/** Normalize CRLF and isolated CR to LF (match and write-back live in LF space). */
function normalizeToLf(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Line count of a raw string: 0 when empty, else newline count + 1. */
function countLines(s: string): number {
  if (s.length === 0) return 0;
  let count = 1;
  for (const ch of s) {
    if (ch === "\n") count += 1;
  }
  return count;
}
