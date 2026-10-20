import type { TokenUsage, UsageCost } from "./types/model.ts";
import { findModelCostRates } from "./catalog.ts";

/**
 * Usage aggregation and cost computation (Di baseline `Core/Llm/TokenUsage.cs`
 * `Add` / `SumOrNull` + `Core/Llm/CostAccounting.cs` `ModelCostRates` /
 * `UsageCost` / `CostCalculator`; models-and-auth.md §Token 与缓存计量).
 *
 * Null/undefined fields mean "not reported by the provider" — never defaulted to
 * zero during aggregation (a missing side keeps the other), and an unknown model
 * rate yields an absent cost, never a fabricated zero.
 *
 * The agent loop owns per-call accumulation across a turn
 * (`packages/agent/src/agent-loop.ts` `addUsage` / `combineCost`); these helpers
 * are the canonical library forms of those exact semantics.
 */

/** Per-million-token cost rates (from C# `ModelCostRates`), sourced from the catalog. */
export interface ModelCostRates {
  /** USD per 1M input tokens (cache misses). */
  readonly inputPerMillion: number;
  /** USD per 1M output tokens. */
  readonly outputPerMillion: number;
  /** USD per 1M cache-read input tokens. */
  readonly cacheReadPerMillion: number;
  /** USD per 1M cache-write input tokens. */
  readonly cacheWritePerMillion: number;
}

/** Identity element for {@link tokenUsageAdd}: a call with nothing reported. */
export function tokenUsageZero(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

/**
 * Accumulate two usages (C# `TokenUsage.Add`). Required counts always sum;
 * optional counts follow `SumOrNull` — one side null (not reported) keeps the
 * other, both null stays null, so `add(Zero, x)` never folds `x`'s cache or
 * reasoning fields into undefined and real data is never lost.
 */
export function tokenUsageAdd(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.totalTokens !== undefined || b.totalTokens !== undefined
      ? { totalTokens: sumOrNull(a.totalTokens, b.totalTokens) }
      : {}),
    ...(a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined
      ? { cacheReadTokens: sumOrNull(a.cacheReadTokens, b.cacheReadTokens) }
      : {}),
    ...(a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: sumOrNull(a.cacheWriteTokens, b.cacheWriteTokens) }
      : {}),
    ...(a.reasoningTokens !== undefined || b.reasoningTokens !== undefined
      ? { reasoningTokens: sumOrNull(a.reasoningTokens, b.reasoningTokens) }
      : {}),
  };
}

/**
 * Sum an optional count across two usages: a missing (undefined = not reported)
 * side keeps the other; only when both are present do they add.
 */
function sumOrNull(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}

/**
 * Billable input = cache-miss input + cache-read + cache-write (C#
 * `TokenUsage.BillableInputTokens`). Missing cache fields count as zero here —
 * unlike aggregation, this is a *derived billing number*, so zeroing absent
 * components is the intended semantics.
 */
export function billableInputTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

/**
 * Prefix-cache hit rate = cache-read ÷ billable input (C#
 * `TokenUsage.CacheHitRate`). Returns `undefined` when there is no billable
 * input (avoids a division by zero); a usage with no cache read yields 0.
 */
export function cacheHitRate(usage: TokenUsage): number | undefined {
  const billable = billableInputTokens(usage);
  return billable > 0 ? (usage.cacheReadTokens ?? 0) / billable : undefined;
}

/** Identity element for {@link usageCostAdd} (`UsageCost.Zero`). */
export function usageCostZero(): UsageCost {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Total USD cost across the four components (C# `UsageCost.Total`). */
export function usageCostTotal(cost: UsageCost): number {
  return cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
}

/** Accumulate two costs component-wise (C# `UsageCost.Add`). */
export function usageCostAdd(a: UsageCost, b: UsageCost): UsageCost {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/**
 * Accumulate an optional cost across model calls (C# `ReAct.CombineCost`): a
 * missing side keeps the other, and a turn with no known rates stays
 * `undefined` — never fabricated as zero.
 */
export function combineCost(acc: UsageCost | undefined, next: UsageCost | undefined): UsageCost | undefined {
  if (next === undefined) return acc;
  if (acc === undefined) return next;
  return usageCostAdd(acc, next);
}

/**
 * Convert a {@link TokenUsage} into a {@link UsageCost} using per-million rates
 * (C# `CostCalculator.Calculate`). Each component is billed at its own rate
 * (cache reads/writes are cheaper than fresh input, so mixing them overstates
 * cost); missing cache counts are billed as zero.
 */
export function calculateCost(rates: ModelCostRates, usage: TokenUsage): UsageCost {
  return {
    input: (rates.inputPerMillion * usage.inputTokens) / 1_000_000,
    output: (rates.outputPerMillion * usage.outputTokens) / 1_000_000,
    cacheRead: (rates.cacheReadPerMillion * (usage.cacheReadTokens ?? 0)) / 1_000_000,
    cacheWrite: (rates.cacheWritePerMillion * (usage.cacheWriteTokens ?? 0)) / 1_000_000,
  };
}

/**
 * Facade over the catalog for one model call (C# `LlmRuntime.CalculateCost`):
 * resolve the (provider, model) rates and compute the cost. Returns
 * `undefined` — never a zero cost — when the provider or model is unknown or the
 * model has no rates (e.g. subscription models like gpt-6.1-sol).
 */
export function costForModel(provider: string, model: string, usage: TokenUsage): UsageCost | undefined {
  const rates = findModelCostRates(provider, model);
  return rates === undefined ? undefined : calculateCost(rates, usage);
}
