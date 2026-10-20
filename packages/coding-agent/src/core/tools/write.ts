import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CoreTool } from "./types.ts";
import { errorObservation, okObservation } from "./types.ts";
import { getContent, getRequiredString, parseArguments, toolSchema } from "./args.ts";
import { isErrno, messageOf } from "./errors.ts";
import { resolvePath } from "./paths.ts";

/**
 * write_file: create or fully overwrite a file (never append), auto-creating
 * missing parent directories. Mirrors `Core/Tools/WriteFileTool.cs` at 09f4e08.
 * Written bytes are UTF-8 without BOM (the .NET default serializer). Expected
 * failures (directory target, locked/read-only file, path is a file) become
 * "error:" observations — no silent data loss.
 */
export function createWriteFileTool(baseDirectory: string): CoreTool {
  return {
    spec: {
      name: "write_file",
      description: "创建新文件或完全覆盖现有文件（自动创建缺失的父目录）。",
      parameters: toolSchema([
        ["path", "string", "要写入的文件路径（相对工作区根目录）"],
        ["content", "string", "完整文件内容，会覆盖原有内容"],
      ]),
    },
    promptSnippet: "整体覆盖写入文件",
    promptGuidelines: [
      "write_file 是覆盖不是追加；覆盖前若不确定文件现状，先用 read_file/glob 确认",
    ],
    async execute(argumentsJson, signal) {
      signal?.throwIfAborted();

      const parsed = parseArguments(argumentsJson);
      if (!parsed.ok) return errorObservation(parsed.error);
      const pathResult = getRequiredString(parsed.value, "path");
      if (!pathResult.ok) return errorObservation(pathResult.error);
      const contentResult = getContent(parsed.value, "content");
      if (!contentResult.ok) return errorObservation(contentResult.error);

      const path = pathResult.value;
      let full: string;
      try {
        full = resolvePath(baseDirectory, path);
      } catch (error) {
        return errorObservation(`error: 写入失败: ${messageOf(error)}`);
      }
      signal?.throwIfAborted();

      // Refuse to write over a directory before touching anything.
      try {
        const existing = await stat(full);
        if (existing.isDirectory()) {
          return errorObservation(`error: 目标路径是目录，无法写入: ${path}`);
        }
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          return errorObservation(`error: 写入失败: ${messageOf(error)}`);
        }
      }
      signal?.throwIfAborted();

      try {
        await mkdir(dirname(full), { recursive: true });
      } catch (error) {
        return errorObservation(`error: 写入失败: ${messageOf(error)}`);
      }
      signal?.throwIfAborted();

      try {
        await writeFile(full, contentResult.value, "utf8");
      } catch (error) {
        return errorObservation(`error: 写入失败: ${messageOf(error)}`);
      }
      return okObservation(`OK: 已写入 ${contentResult.value.length} 字符到 ${path}`);
    },
  };
}
