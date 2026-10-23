import { stat } from "node:fs/promises";
import { relative } from "node:path";
import { performance } from "node:perf_hooks";
import type { Stats } from "node:fs";
import type { CoreTool } from "./types.ts";
import { errorObservation, okObservation } from "./types.ts";
import { getOptionalInt, getRequiredString, parseArguments, toolSchema } from "./args.ts";
import { messageOf } from "./errors.ts";
import { normalizeToolPath, resolvePath } from "./paths.ts";
import { enumerateFiles } from "./enumerate.ts";
import { globToRegex } from "./glob-matcher.ts";

/** Default result cap (GlobTool.MaxResults). */
export const GLOB_DEFAULT_LIMIT = 200;
/** Default wall-clock scan budget in ms (GlobTool.DefaultScanBudgetSeconds). */
export const GLOB_DEFAULT_SCAN_BUDGET_MS = 60_000;

export interface GlobToolOptions {
  /** Override the default result cap (host/test injection; GlobTool.MaxResults). */
  readonly defaultLimit?: number;
  /** Override the wall-clock scan budget in ms (DefaultScanBudgetSeconds). */
  readonly scanBudgetMs?: number;
}

/*
 * glob: recursively locate files by pattern (`*` within one directory level,
 * `?` one character, `**` across directories), returning paths relative to the
 * search start with `/` separators, capped at `limit` (default 200). Ported
 * from.
 *
 * The scan is a truly async cancellable directory walk (`enumerateFiles`): a
 * synchronous scan wrapped in a Promise is NOT used (execution-plan gate).
 * Reaching the limit or the scan budget returns partial results with an
 * explicit "not exhausted" notice — never a fake "no match".
 */
export function createGlobTool(baseDirectory: string, options?: GlobToolOptions): CoreTool {
  const defaultLimit = options?.defaultLimit ?? GLOB_DEFAULT_LIMIT;
  const scanBudgetMs = options?.scanBudgetMs ?? GLOB_DEFAULT_SCAN_BUDGET_MS;
  return {
    spec: {
      name: "glob",
      description:
        "按 glob 模式递归查找文件（如 **/*.py、src/components/**/Button.tsx）。返回相对搜索起点的路径列表，最多 200 条（可用 limit 调整）；无匹配返回（未找到匹配文件）。",
      parameters: toolSchema(
        [["pattern", "string", "glob 模式（* 同目录内任意段，? 单字符，** 跨目录）"]],
        [
          ["path", "string", "可选：搜索起点目录（默认工作区根目录）"],
          ["limit", "integer", "可选：最多返回的结果条数（默认 200）"],
        ],
      ),
    },
    promptSnippet: "按文件名模式（* ? **）搜索文件，返回相对路径",
    promptGuidelines: [],
    async execute(argumentsJson, signal) {
      signal?.throwIfAborted();

      const parsed = parseArguments(argumentsJson);
      if (!parsed.ok) return errorObservation(parsed.error);
      const patternResult = getRequiredString(parsed.value, "pattern");
      if (!patternResult.ok) return errorObservation(patternResult.error);
      const limitResult = getOptionalInt(parsed.value, "limit");
      if (!limitResult.ok) return errorObservation(limitResult.error);

      const pathArg = optionalPath(parsed.value);
      let searchRoot: string;
      try {
        searchRoot = pathArg === undefined ? baseDirectory : resolvePath(baseDirectory, pathArg);
      } catch (error) {
        return errorObservation(`error: 路径参数非法: ${messageOf(error)}`);
      }
      signal?.throwIfAborted();

      // Directory.Exists/File.Exists: every stat failure here reads as "目录不存在"
      // (they swallow access errors too); a file (not directory) is called out.
      let rootStat: Stats;
      try {
        rootStat = await stat(searchRoot);
      } catch {
        return errorObservation(`error: 目录不存在: ${pathArg ?? ""}`);
      }
      if (!rootStat.isDirectory()) {
        return errorObservation(`error: 路径是文件而非目录: ${pathArg ?? ""}`);
      }
      signal?.throwIfAborted();

      const effectiveLimit = Math.max(1, limitResult.value ?? defaultLimit);
      const regex = globToRegex(
        patternResult.value,
        process.platform === "win32",
        process.platform === "win32",
      );
      const results: string[] = [];
      const startedAt = performance.now();
      let scanBudgetExceeded = false;
      for await (const file of enumerateFiles(searchRoot, signal)) {
        signal?.throwIfAborted();
        if (performance.now() - startedAt >= scanBudgetMs) {
          scanBudgetExceeded = true;
          break;
        }
        const rel = normalizeToolPath(relative(searchRoot, file));
        if (regex.test(rel)) {
          results.push(rel);
          if (results.length >= effectiveLimit) break;
        }
      }

      let output =
        results.length === 0 && !scanBudgetExceeded ? "（未找到匹配文件）" : results.join("\n");
      if (results.length >= effectiveLimit) {
        output += `\n\n[${effectiveLimit} 条结果上限已到。用 limit=${effectiveLimit * 2} 查看更多，或缩小 pattern]`;
      }
      if (scanBudgetExceeded) {
        output += `\n\n[扫描超过 ${formatScanSeconds(scanBudgetMs)} 秒预算，已返回部分结果。请缩小 path/glob 范围后重试]`;
      }
      return okObservation(output);
    },
  };
}

/** TryGetOptionalString: missing / non-string / blank → undefined (ignored). */
function optionalPath(args: Readonly<Record<string, unknown>>): string | undefined {
  const value = args["path"];
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value;
}

/** Format the budget like. */
export function formatScanSeconds(ms: number): string {
  const seconds = Math.round((ms / 1000) * 10) / 10;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}
