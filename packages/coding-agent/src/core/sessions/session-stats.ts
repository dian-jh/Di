/**
 * Session stats aggregation (P5).
 *
 * docs/migration/typescript-core/sessions-and-compatibility.md §"审计型回合" +
 * the stats gate "累计快照不会重复统计，未知字段不伪造已知"; C# baseline
 * `Core/Sessions/SessionStats.cs` `Aggregate`.
 *
 * Aggregates every `task_complete` record exactly once into a cumulative
 * snapshot (turns, token counts, cost, duration). Unknown/extra fields and
 * unknown record types are never faked into known counts; a malformed record is
 * skipped WHOLE (no partial totals survive a bad field); missing usage fields
 * default to zero only for token counts, never for cost; the cache hit rate is
 * cacheRead / (input + cacheRead + cacheWrite), null when there is no billable
 * input. Unparseable lines are skipped tolerantly. A missing/unreadable file
 * throws (the C# IOException equivalent).
 */

import { readFileSync } from "node:fs";

/** Cumulative aggregate of one session file. */
export interface SessionStatsSummary {
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** cacheRead / (input + cacheRead + cacheWrite); undefined when no billable input. */
  readonly cacheHitRate: number | undefined;
  /** Sum of `task_complete.cost.total`; undefined until any turn reports cost (never faked as 0). */
  readonly totalCost: number | undefined;
  /** Sum of `task_complete.duration_ms`; undefined when no record carries it. */
  readonly totalDurationMs: number | undefined;
}

/** Aggregate one session JSONL file into its cumulative snapshot. */
export function aggregateSessionStats(logFilePath: string): SessionStatsSummary {
  let text: string;
  try {
    text = readFileSync(logFilePath, "utf8");
  } catch (cause) {
    throw new Error(`无法读取会话文件: ${logFilePath}`, { cause });
  }

  let turns = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalCost: number | undefined;
  let totalDuration: number | undefined;

  for (const raw of text.split("\n")) {
    if (raw.trim().length === 0) continue;
    let root: unknown;
    try {
      root = JSON.parse(raw);
    } catch {
      continue; // tolerant: unparseable lines are skipped, aggregation continues
    }
    try {
      const record = root as Record<string, unknown>;
      if (record?.type !== "event_msg") continue;
      const payload = record.payload;
      if (payload === null || typeof payload !== "object") continue;
      const p = payload as Record<string, unknown>;
      if (p.type !== "task_complete") continue;

      const nextInput = input + intField(p.usage, "input_tokens");
      const nextOutput = output + intField(p.usage, "output_tokens");
      const nextRead = cacheRead + intField(p.usage, "cache_read_tokens");
      const nextWrite = cacheWrite + intField(p.usage, "cache_write_tokens");
      let nextCost = totalCost;
      let nextDuration = totalDuration;

      if (p.cost !== undefined) {
        if (p.cost === null || typeof p.cost !== "object") throw new TypeError("bad cost");
        const total = (p.cost as Record<string, unknown>).total;
        if (total !== undefined) {
          if (typeof total !== "number" || !Number.isFinite(total)) throw new TypeError("non-finite session cost");
          nextCost = (totalCost ?? 0) + total;
        }
      }
      if (p.duration_ms !== undefined) {
        if (typeof p.duration_ms !== "number" || !Number.isInteger(p.duration_ms)) {
          throw new TypeError("bad duration_ms");
        }
        nextDuration = (totalDuration ?? 0) + p.duration_ms;
      }

      turns += 1;
      input = nextInput;
      output = nextOutput;
      cacheRead = nextRead;
      cacheWrite = nextWrite;
      totalCost = nextCost;
      totalDuration = nextDuration;
    } catch {
      // The whole record is skipped: no partial totals are kept.
    }
  }

  const billable = input + cacheRead + cacheWrite;
  const cacheHitRate = billable > 0 ? cacheRead / billable : undefined;
  return {
    turns,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheHitRate,
    totalCost,
    totalDurationMs: totalDuration,
  };
}

/**
 * Read one integer usage token count. Absent field -> 0 (C# `GetInt64` default);
 * a null/mistyped/primitive usage object or a non-integer field throws so the
 * whole record is skipped (C# `GetInt64` on a wrong token type throws).
 */
function intField(usage: unknown, key: string): number {
  if (usage === undefined) return 0;
  if (usage === null || typeof usage !== "object") throw new TypeError(`bad usage field '${key}'`);
  const value = (usage as Record<string, unknown>)[key];
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new TypeError(`bad ${key}`);
  return value;
}
