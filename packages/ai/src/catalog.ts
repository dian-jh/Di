import type { ModelCostRates } from "./usage.ts";

/**
 * Data-driven model catalog (Di baseline `Core/Llm/ModelCatalog.cs` +
 * per-provider `Catalog` in `Core/Providers/DeepSeek/DeepSeekAdapter.cs` /
 * `ChatGptAdapter.cs`; models-and-auth.md §Token 与缓存计量 and
 * docs/modules/llm.md). Adding a model is a data change, never engine code.
 *
 * The catalog is advisory: a model id not listed is still accepted by an adapter,
 * and a model with no {@link ModelCostRates} has an *unknown* cost — consumers
 * must keep `cost` absent (undefined), never fabricate a zero (red list:
 * "未知成本 / 缓存不伪造为零"). `gpt-6.1-sol` is a subscription model with no
 * per-token rate in the baseline, so it deliberately has no `cost`.
 */

/** One advisory catalog record (pure data; mirrors C# `ModelSpec`). */
export interface ModelSpec {
  /** Provider-local model id (wire `model` value). */
  readonly id: string;
  /** Human-readable display name. */
  readonly name: string;
  /** Advertised context window in tokens, when known. */
  readonly contextWindow?: number;
  /** Suggested default `maxTokens`, when known. */
  readonly defaultMaxTokens?: number;
  /** Per-million-token cost rates; absent means cost is unknown (not zero). */
  readonly cost?: ModelCostRates;
}

/**
 * Per-provider catalog. Provider keys are the unified provider ids used by
 * {@link ModelRef} / the model registry ("deepseek", "chatgpt"). Rates are
 * transcribed from the C# baseline adapters' `Catalog` records.
 */
export const MODEL_CATALOG: Readonly<Record<string, readonly ModelSpec[]>> = {
  deepseek: [
    {
      id: "deepseek-flash",
      name: "DeepSeek Flash (V4.1)",
      contextWindow: 1_000_000,
      defaultMaxTokens: 64 * 1024,
      cost: { inputPerMillion: 0.28, outputPerMillion: 0.42, cacheReadPerMillion: 0.07, cacheWritePerMillion: 0 },
    },
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      contextWindow: 1_000_000,
      defaultMaxTokens: 64 * 1024,
      cost: { inputPerMillion: 1.2, outputPerMillion: 4.0, cacheReadPerMillion: 0.3, cacheWritePerMillion: 0 },
    },
  ],
  chatgpt: [
    {
      id: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      contextWindow: 1_050_000,
      // 订阅制：基线无每 token 费率 → cost 保持未知（undefined），不得伪造为零。
    },
  ],
};

/**
 * Resolve the per-million cost rates for a (provider, model) pair. Returns
 * `undefined` when the provider is unknown, the model is not in the catalog, or
 * the model has no rates — the caller must keep cost absent, never zero.
 */
export function findModelCostRates(provider: string, model: string): ModelCostRates | undefined {
  return MODEL_CATALOG[provider]?.find((spec) => spec.id === model)?.cost;
}
