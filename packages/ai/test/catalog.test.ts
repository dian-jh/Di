import test from "node:test";
import assert from "node:assert/strict";

import type { TokenUsage, UsageCost } from "@di/ai";
import { costForModel, findModelCostRates } from "@di/ai";

/**
 * P3 card 4 red list — data-driven model cost catalog (Di baseline
 * `Core/Providers/DeepSeek/DeepSeekAdapter.cs` / `ChatGptAdapter.cs` `Catalog`
 * + `Core/Llm/ModelCatalog.cs`; models-and-auth.md §Token 与缓存计量: "未知成本 /
 * 缓存不伪造为零"): per-provider input/output/cache rates are catalog data (not
 * hardcoded in the loop); a model or provider without known rates yields an
 * absent cost, never a fabricated zero.
 */

test("deepseek-flash has known per-million rates", () => {
  const rates = findModelCostRates("deepseek", "deepseek-flash");

  assert.ok(rates, "deepseek-flash must be in the catalog");
  assert.equal(rates?.inputPerMillion, 0.28);
  assert.equal(rates?.outputPerMillion, 0.42);
  assert.equal(rates?.cacheReadPerMillion, 0.07);
  assert.equal(rates?.cacheWritePerMillion, 0);
});

test("deepseek-v4-pro has known per-million rates", () => {
  const rates = findModelCostRates("deepseek", "deepseek-v4-pro");

  assert.ok(rates, "deepseek-v4-pro must be in the catalog");
  assert.equal(rates?.inputPerMillion, 1.2);
  assert.equal(rates?.outputPerMillion, 4.0);
  assert.equal(rates?.cacheReadPerMillion, 0.3);
});

test("gpt-6.1-sol has no cost rates (subscription model — unknown is NOT zero)", () => {
  assert.equal(findModelCostRates("chatgpt", "gpt-6.1-sol"), undefined);
});

test("unknown model id in a known provider has no rates", () => {
  assert.equal(findModelCostRates("deepseek", "ghost-model"), undefined);
});

test("unknown provider has no rates", () => {
  assert.equal(findModelCostRates("ghost", "deepseek-flash"), undefined);
});

// ---------------------------------------------------------------------------
// costForModel — the LlmRuntime.CalculateCost facade (catalog lookup + calc)
// ---------------------------------------------------------------------------

test("costForModel known model computes cost from the catalog rates", () => {
  const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };

  const cost = costForModel("deepseek", "deepseek-flash", usage);

  assert.ok(cost, "known rates must produce a cost");
  assert.equal(cost?.input, 0.28);
  assert.equal(cost?.output, 0.42);
  assert.equal(cost?.cacheRead, 0.07);
});

test("costForModel accounts cache tokens at the per-model rate", () => {
  // deepseek-v4-pro 缓存读 $0.30/M，比 flash 的 $0.07/M 更贵 —— 缓存不能按错模型或按零计。
  const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000 };

  const cost = costForModel("deepseek", "deepseek-v4-pro", usage);

  assert.equal(cost?.cacheRead, 0.3);
});

test("costForModel unknown provider returns undefined (NOT a zero cost)", () => {
  const cost = costForModel("ghost", "deepseek-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000 });

  assert.equal(cost, undefined);
});

test("costForModel unknown model returns undefined (NOT a zero cost)", () => {
  const cost = costForModel("deepseek", "ghost-model", { inputTokens: 1_000_000, outputTokens: 1_000_000 });

  assert.equal(cost, undefined);
});

test("costForModel model without catalog rates returns undefined (NOT a zero cost)", () => {
  const cost = costForModel("chatgpt", "gpt-6.1-sol", { inputTokens: 1_000_000, outputTokens: 1_000_000 });

  assert.equal(cost, undefined);
});

test("costForModel computed cost is a UsageCost shape with a nonzero total", () => {
  const cost = costForModel("deepseek", "deepseek-flash", {
    inputTokens: 500_000,
    outputTokens: 500_000,
    cacheReadTokens: 500_000,
  });
  const expected: UsageCost = { input: 0.14, output: 0.21, cacheRead: 0.035, cacheWrite: 0 };

  assert.deepEqual(cost, expected);
});
