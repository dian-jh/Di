import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import type { Stats } from "node:fs";
import type { CoreTool } from "./types.ts";
import { errorObservation, okObservation } from "./types.ts";
import {
  getOptionalBool,
  getOptionalInt,
  getRequiredString,
  parseArguments,
  toolSchema,
} from "./args.ts";
import { messageOf } from "./errors.ts";
import { resolvePath } from "./paths.ts";
import { enumerateFiles } from "./enumerate.ts";
import { globToRegex } from "./glob-matcher.ts";
import { formatScanSeconds } from "./glob.ts";
import { decodeSmart, type LegacyDecoder } from "./encoding.ts";
import { resolveOemDecoder, splitLines } from "./read.ts";

/** Default result cap (C# GrepTool.MaxResults). */
export const GREP_DEFAULT_LIMIT = 100;
/** Default wall-clock scan budget in ms (C# GrepTool.DefaultScanBudgetSeconds). */
export const GREP_DEFAULT_SCAN_BUDGET_MS = 60_000;
/** Single-file size cap; larger files are skipped and reported (C# MaxFileBytes). */
export const GREP_MAX_FILE_BYTES = 1 << 20;
/** Single matched line is truncated past this many characters (C# MaxMatchLineChars). */
export const GREP_MAX_MATCH_LINE_CHARS = 500;
/**
 * Per-regex-job timeout in ms (TS-only safety boundary, P4-regex-probe): a
 * pathological pattern can hang a single line for >60s, so each file's regex job
 * runs in a worker thread that is terminated after this budget — the scan budget
 * alone cannot interrupt a running regex.
 */
export const GREP_REGEX_TIMEOUT_MS = 10_000;

export interface GrepToolOptions {
  /** Override the default result cap (host/test injection; C# GrepTool.MaxResults). */
  readonly defaultLimit?: number;
  /** Override the wall-clock scan budget in ms (C# DefaultScanBudgetSeconds). */
  readonly scanBudgetMs?: number;
  /** Override the per-regex-job worker timeout in ms (P4-regex-probe). */
  readonly regexTimeoutMs?: number;
  /** Override the 1 MiB file-size cap (C# MaxFileBytes). */
  readonly maxFileBytes?: number;
  /** Override the system OEM code page used for non-UTF-8 files (undefined = auto-discover). */
  readonly oemCodePage?: number;
}

/**
 * grep: regex search over enumerated file contents, returning `rel:line: text`
 * matches. Ported from `Core/Tools/GrepTool.cs` at 09f4e08 with the worker
 * safety boundary mandated by P4-regex-probe + tools-and-platform.md: every
 * bounded regex job runs in a worker_threads Worker so a catastrophic pattern is
 * terminated via `worker.terminate()` instead of hanging the loop; abort also
 * terminates the worker and rejects with AbortError.
 *
 * File content is decoded like read_file (P4-win-encoding-probe): strict UTF-8
 * first (BOM stripped), then the system OEM code page; files that decode
 * neither are skipped and reported, never silently mojibake'd.
 *
 * .NET -> JS regex bridging (probe §推荐结论): the `u` flag is always set so
 * `\p{…}` works and identity escapes like `\A`/`\z`/`\Z` never silently match as
 * literals; `\A`/`\z`/`\Z` are translated to `^`/`$` (equivalent per line, since
 * a line has no newlines); `.NET`-only syntax that JS rejects (single-quote
 * named groups, balanced/conditional groups, `\p{IsScript}`…) becomes an
 * explicit `error:` observation, never a silent empty result. Known difference
 * kept: JS `\w`/`\d`/`\b` are ASCII-only even under `u`, unlike .NET's Unicode
 * versions (recorded, not silently patched in this card).
 */
export function createGrepTool(baseDirectory: string, options?: GrepToolOptions): CoreTool {
  const defaultLimit = options?.defaultLimit ?? GREP_DEFAULT_LIMIT;
  const scanBudgetMs = options?.scanBudgetMs ?? GREP_DEFAULT_SCAN_BUDGET_MS;
  const regexTimeoutMs = options?.regexTimeoutMs ?? GREP_REGEX_TIMEOUT_MS;
  const maxFileBytes = options?.maxFileBytes ?? GREP_MAX_FILE_BYTES;

  return {
    spec: {
      name: "grep",
      description:
        "在文件内容中按模式逐行搜索，返回 file:行号: 内容（如 src/api.py:42: # TODO: ...）。可用 glob 过滤文件、path 限定目录、context 显示上下文行、ignore_case/literal 控制匹配方式。默认最多 100 条（可用 limit 调整），长行按 500 字符截断。",
      parameters: toolSchema(
        [["pattern", "string", "要搜索的正则表达式（literal 模式下为普通文本）"]],
        [
          ["path", "string", "可选：搜索起点目录（默认工作区根目录）"],
          ["glob", "string", "可选：只搜索路径匹配该 glob 的文件，如 *.cs"],
          ["ignore_case", "boolean", "可选：大小写不敏感匹配（默认 false）"],
          ["literal", "boolean", "可选：把 pattern 当普通文本而非正则（默认 false）"],
          ["context", "integer", "可选：匹配行前后各显示的上下文行数（默认 0）"],
          ["limit", "integer", "可选：最多返回的匹配条数（默认 100）"],
        ],
      ),
    },
    promptSnippet: "按模式搜索文件内容，返回 file:行号: 内容",
    promptGuidelines: ["定位代码逻辑用 grep 先搜再读，不要编造文件内容"],
    async execute(argumentsJson, signal) {
      signal?.throwIfAborted();

      const parsed = parseArguments(argumentsJson);
      if (!parsed.ok) return errorObservation(parsed.error);
      const patternResult = getRequiredString(parsed.value, "pattern");
      if (!patternResult.ok) return errorObservation(patternResult.error);
      const ignoreCaseResult = getOptionalBool(parsed.value, "ignore_case");
      if (!ignoreCaseResult.ok) return errorObservation(ignoreCaseResult.error);
      const literalResult = getOptionalBool(parsed.value, "literal");
      if (!literalResult.ok) return errorObservation(literalResult.error);
      const contextResult = getOptionalInt(parsed.value, "context");
      if (!contextResult.ok) return errorObservation(contextResult.error);
      const limitResult = getOptionalInt(parsed.value, "limit");
      if (!limitResult.ok) return errorObservation(limitResult.error);

      const compiled = compileGrepRegex(
        patternResult.value,
        literalResult.value === true,
        ignoreCaseResult.value === true,
      );
      if (!compiled.ok) return errorObservation(compiled.error);

      const pathArg = optionalString(parsed.value, "path");
      let searchRoot: string;
      try {
        searchRoot = pathArg === undefined ? baseDirectory : resolvePath(baseDirectory, pathArg);
      } catch (error) {
        return errorObservation(`error: 路径参数非法: ${messageOf(error)}`);
      }
      signal?.throwIfAborted();

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

      const globArg = optionalString(parsed.value, "glob");
      const globRegex = globArg === undefined ? null : globToRegex(globArg, process.platform === "win32");

      const effectiveLimit = Math.max(1, limitResult.value ?? defaultLimit);
      const contextValue = contextResult.value !== undefined && contextResult.value > 0
        ? contextResult.value
        : 0;

      const results: string[] = [];
      let matchCount = 0;
      let matchLimitReached = false;
      let linesTruncated = false;
      let scanBudgetExceeded = false;
      const skippedOversize: string[] = [];
      let skippedOversizeTotal = 0;
      const skippedRegexTimeout: string[] = [];
      let skippedRegexTimeoutTotal = 0;
      const skippedDecode: string[] = [];
      let skippedDecodeTotal = 0;

      const runner = new RegexWorkerPool();
      const startedAt = performance.now();
      try {
        for await (const file of enumerateFiles(searchRoot, signal)) {
          signal?.throwIfAborted();
          if (performance.now() - startedAt >= scanBudgetMs) {
            scanBudgetExceeded = true;
            break;
          }
          if (matchCount >= effectiveLimit) break;

          const rel = relative(searchRoot, file).replace(/\\/g, "/");
          if (globRegex !== null && !globRegex.test(rel)) continue;

          // C# FileInfo.Length check first so oversized files are never read.
          let info: Stats;
          try {
            info = await stat(file);
          } catch {
            continue; // vanished/unreadable file -> skip like C# GetFiles drift
          }
          if (info.size > maxFileBytes) {
            skippedOversizeTotal += 1;
            if (skippedOversize.length < 3) skippedOversize.push(rel);
            continue;
          }

          let bytes: Uint8Array;
          try {
            bytes = await readFile(file);
          } catch {
            continue; // per-file IO errors swallowed (C# catches IOException/UnauthorizedAccess)
          }
          signal?.throwIfAborted();

          const decoded = await decodeSmart(bytes.subarray(stripBom(bytes)), () =>
            resolveOemDecoder({ oemCodePage: options?.oemCodePage }),
          );
          if (!decoded.ok) {
            skippedDecodeTotal += 1;
            if (skippedDecode.length < 3) skippedDecode.push(rel);
            continue;
          }
          signal?.throwIfAborted();

          const lines = splitLines(decoded.text);
          if (lines.length === 0) continue;

          let hits: number[] | null;
          try {
            hits = await runner.run(compiled.source, compiled.flags, lines, regexTimeoutMs, signal);
          } catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw error;
            continue; // worker failure on this file -> skip like C# swallows per-file errors
          }
          if (hits === null) {
            skippedRegexTimeoutTotal += 1;
            if (skippedRegexTimeout.length < 3) skippedRegexTimeout.push(rel);
            continue;
          }
          signal?.throwIfAborted();

          if (contextValue === 0) {
            for (const n of hits) {
              matchCount += 1;
              const { text, truncated } = truncateLine(lines[n - 1]!);
              if (truncated) linesTruncated = true;
              results.push(`${rel}:${n}: ${text}`);
              if (matchCount >= effectiveLimit) {
                matchLimitReached = true;
                break;
              }
            }
          } else {
            const ctx = appendContextWindows(results, rel, lines, hits, contextValue, effectiveLimit, matchCount);
            matchCount = ctx.matchCount;
            if (ctx.limitReached) matchLimitReached = true;
            if (ctx.truncated) linesTruncated = true;
          }
        }
      } finally {
        await runner.close();
      }

      // Skips of any kind suppress the "no match" marker: not having searched a
      // file must never masquerade as "no match" (C# regression, and the same
      // rule for regex-timeout/decode skips added in the TS port).
      let output =
        results.length === 0 &&
        skippedOversizeTotal === 0 &&
        skippedRegexTimeoutTotal === 0 &&
        skippedDecodeTotal === 0 &&
        !scanBudgetExceeded
          ? "（未找到匹配）"
          : results.join("\n");
      const notices: string[] = [];
      if (scanBudgetExceeded) {
        notices.push(
          `扫描超过 ${formatScanSeconds(scanBudgetMs)} 秒预算，已返回部分结果。请缩小 path/glob 范围，或换更具体的 pattern 后重试`,
        );
      }
      if (skippedOversizeTotal > 0) {
        notices.push(
          `${skippedOversizeTotal} 个文件超过 ${Math.floor(maxFileBytes / (1024 * 1024))} MiB 已跳过（如 ${formatSamples(skippedOversize)}）。可用 read_file 分段读取，或用 python/findstr 处理`,
        );
      }
      if (skippedRegexTimeoutTotal > 0) {
        notices.push(
          `${skippedRegexTimeoutTotal} 个文件正则匹配超时（单文件超过 ${formatScanSeconds(regexTimeoutMs)} 秒）已终止并跳过（如 ${formatSamples(skippedRegexTimeout)}）。可换更简单的 pattern，或用 read_file 分段读取`,
        );
      }
      if (skippedDecodeTotal > 0) {
        notices.push(
          `${skippedDecodeTotal} 个文件无法解码已跳过（如 ${formatSamples(skippedDecode)}）。可用 read_file 或 python 处理`,
        );
      }
      if (matchLimitReached) {
        notices.push(
          `${effectiveLimit} 条匹配上限已到。用 limit=${effectiveLimit * 2} 查看更多，或缩小 pattern`,
        );
      }
      if (linesTruncated) {
        notices.push(`部分行超过 ${GREP_MAX_MATCH_LINE_CHARS} 字符已截断，用 read_file 查看完整行`);
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      return okObservation(output);
    },
  };
}

/**
 * Compile the effective pattern for matching. `literal` escapes the pattern
 * (C# Regex.Escape); otherwise .NET start/end anchors are bridged. The `u` flag
 * is always set (P4-regex-probe): `\p{…}` works and .NET identity escapes never
 * silently match as literals. A compile failure (invalid regex, or .NET-only
 * syntax JS rejects) is returned as the tool's `error:` observation.
 */
function compileGrepRegex(
  pattern: string,
  literal: boolean,
  ignoreCase: boolean,
): { readonly ok: true; readonly source: string; readonly flags: string } | { readonly ok: false; readonly error: string } {
  const source = literal ? escapeRegExpLiteral(pattern) : translateAnchors(pattern);
  const flags = `u${ignoreCase ? "i" : ""}`;
  try {
    new RegExp(source, flags);
  } catch (error) {
    return { ok: false, error: `error: 无效正则表达式: ${messageOf(error)}` };
  }
  return { ok: true, source, flags };
}

/**
 * Bridge the .NET start/end anchors to their per-line JS equivalents: `\A`→`^`,
 * `\z`→`$`, `\Z`→`$`. Since a grep line never contains a newline, these are
 * semantically identical on a line (P4-regex-probe §推荐结论 2). Handles
 * backslash runs so `\\A` (escaped backslash + A) is not translated.
 */
function translateAnchors(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c !== "\\") {
      out += c;
      i += 1;
      continue;
    }
    let j = i;
    while (j < pattern.length && pattern[j] === "\\") j += 1;
    const backslashCount = j - i;
    const next = pattern[j];
    if (backslashCount % 2 === 1 && (next === "A" || next === "z" || next === "Z")) {
      out += "\\".repeat(backslashCount - 1) + (next === "A" ? "^" : "$");
      i = j + 1;
    } else {
      out += "\\".repeat(backslashCount);
      i = j;
    }
  }
  return out;
}

/** Escape regex metacharacters for literal mode (JS equivalent of C# Regex.Escape). */
function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Port of C# GrepTool.TruncateLine: cap the rendered line at 500 chars. */
function truncateLine(line: string): { text: string; truncated: boolean } {
  if (line.length <= GREP_MAX_MATCH_LINE_CHARS) return { text: line, truncated: false };
  return {
    text: line.slice(0, GREP_MAX_MATCH_LINE_CHARS) + "... [truncated]",
    truncated: true,
  };
}

/**
 * Port of C# GrepTool.ScanWithContext: emit a [line-context, line+context]
 * window per hit, context lines as `rel-N- text`, match lines as `rel:N: text`,
 * overlapping windows deduplicated via `lastEmitted`.
 */
function appendContextWindows(
  results: string[],
  rel: string,
  lines: readonly string[],
  hits: readonly number[],
  context: number,
  effectiveLimit: number,
  matchCount: number,
): { matchCount: number; limitReached: boolean; truncated: boolean } {
  let count = matchCount;
  let limitReached = false;
  let truncated = false;
  let lastEmitted = 0;
  for (const idx of hits) {
    if (count >= effectiveLimit) break;
    count += 1;
    const start = Math.max(1, idx - context);
    const end = Math.min(lines.length, idx + context);
    const effStart = Math.max(start, lastEmitted + 1);
    for (let n = effStart; n <= end; n += 1) {
      const { text, truncated: t } = truncateLine(lines[n - 1]!);
      if (t) truncated = true;
      results.push(n === idx ? `${rel}:${n}: ${text}` : `${rel}-${n}- ${text}`);
    }
    lastEmitted = Math.max(lastEmitted, end);
    if (count >= effectiveLimit) {
      limitReached = true;
      break;
    }
  }
  return { matchCount: count, limitReached, truncated };
}

/** C# TryGetOptionalString: missing / non-string / blank -> undefined (ignored). */
function optionalString(args: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value;
}

/** Sample file names wrapped like C#: `“a”、“b”`. */
function formatSamples(samples: readonly string[]): string {
  return samples.map((s) => `“${s}”`).join("、");
}

function stripBom(bytes: Uint8Array): number {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
}

/**
 * One worker thread per grep call, reused across files, rebuilt after a
 * timeout/abort termination. Every bounded regex job runs here so a pathological
 * pattern can be killed (P4-regex-probe): `worker.terminate()` is proven to stop
 * a catastrophic-backtracking thread within ~5ms without blocking the caller.
 */
class RegexWorkerPool {
  private worker: Worker | null = null;

  /** Return the live worker, creating one lazily (~40ms once per call). */
  private async ensureWorker(): Promise<Worker> {
    if (this.worker === null) {
      this.worker = new Worker(new URL("./regex-worker.js", import.meta.url));
    }
    return this.worker;
  }

  /** Terminate and forget the current worker (idempotent). */
  private async killWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker !== null) {
      worker.removeAllListeners();
      await worker.terminate();
    }
  }

  /**
   * Run one bounded regex job. Resolves with 1-based hit line numbers, or `null`
   * when the job exceeded `timeoutMs` (the worker was terminated and a fresh one
   * is created for the next job). Rejects with AbortError when `signal` aborts
   * (the worker is terminated first). Other worker failures reject with the
   * underlying error; the caller decides whether to skip the file.
   */
  async run(
    pattern: string,
    flags: string,
    lines: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<number[] | null> {
    signal?.throwIfAborted();
    const worker = await this.ensureWorker();
    signal?.throwIfAborted();

    return new Promise<number[] | null>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        worker.removeListener("message", onMessage);
        worker.removeListener("error", onError);
        worker.removeListener("exit", onExit);
      };
      const resolveOnce = (value: number[] | null): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const onMessage = (msg: unknown): void => {
        const result = msg as { ok?: boolean; hits?: readonly number[]; error?: string };
        if (result?.ok !== true && result?.ok !== false) return; // stale / not ours
        if (result.ok) resolveOnce(result.hits === undefined ? [] : [...result.hits]);
        else rejectOnce(new Error(result.error ?? "regex worker error"));
      };
      const onError = (error: Error): void => {
        void this.killWorker().catch(() => {});
        rejectOnce(error);
      };
      const onExit = (code: number): void => {
        this.worker = null;
        rejectOnce(new Error(`regex worker exited with code ${code}`));
      };
      const onAbort = (): void => {
        void this.killWorker().catch(() => {});
        rejectOnce(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      };
      const onTimeout = (): void => {
        void this.killWorker().then(() => resolveOnce(null));
      };

      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      timer = setTimeout(onTimeout, timeoutMs);
      try {
        worker.postMessage({ pattern, flags, lines });
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  /** Terminate the worker and free the pool (called at the end of every scan). */
  async close(): Promise<void> {
    await this.killWorker();
  }
}
