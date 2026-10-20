import test from "node:test";
import assert from "node:assert/strict";

import type { ModelEvent, ProviderChunk, TokenUsage, UsageCost } from "@di/ai";
import { ProviderStreamAssembler } from "@di/ai";
import {
  billableInputTokens,
  cacheHitRate,
  calculateCost,
  combineCost,
  tokenUsageAdd,
  tokenUsageZero,
  usageCostAdd,
  usageCostTotal,
  usageCostZero,
} from "@di/ai";

/**
 * P3 card 4 red list — usage/cost computation (Di baseline
 * `Core/Llm/TokenUsage.cs` Add/SumOrNull + `Core/Llm/CostAccounting.cs`
 * `CostCalculator` / `UsageCost`; models-and-auth.md §Token 与缓存计量):
 * SumOrNull with null sides (one null keeps the other), Add accumulation across
 * calls, known-rate cost computation (input/output/cache), cache accounting per
 * model, and "unknown cost is NOT fabricated as zero".
 */

// ---------------------------------------------------------------------------
// TokenUsage Add / SumOrNull aggregation
// ---------------------------------------------------------------------------

test("tokenUsageZero.add(real) keeps cache and reasoning fields (Add identity)", () => {
  const real: TokenUsage = { inputTokens: 1927, outputTokens: 46, cacheReadTokens: 1792, reasoningTokens: 44 };

  const sum = tokenUsageAdd(tokenUsageZero(), real);

  assert.equal(sum.inputTokens, 1927);
  assert.equal(sum.outputTokens, 46);
  assert.equal(sum.cacheReadTokens, 1792);
  assert.equal(sum.reasoningTokens, 44);
});

test("tokenUsageAdd both sides non-null sums every component", () => {
  const a: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, reasoningTokens: 3 };
  const b: TokenUsage = { inputTokens: 20, outputTokens: 7, cacheReadTokens: 200, reasoningTokens: 5 };

  const sum = tokenUsageAdd(a, b);

  assert.equal(sum.inputTokens, 30);
  assert.equal(sum.outputTokens, 12);
  assert.equal(sum.cacheReadTokens, 300);
  assert.equal(sum.reasoningTokens, 8);
});

test("tokenUsageAdd with one null side keeps the other (SumOrNull)", () => {
  const withCache: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, totalTokens: 15 };
  const plain: TokenUsage = { inputTokens: 20, outputTokens: 7 };

  const sum = tokenUsageAdd(withCache, plain);

  assert.equal(sum.inputTokens, 30);
  assert.equal(sum.outputTokens, 12);
  // 单侧上报的缓存/总计不得被另一侧的未上报折叠成 undefined。
  assert.equal(sum.cacheReadTokens, 100);
  assert.equal(sum.totalTokens, 15);
});

test("tokenUsageAdd both sides null stays undefined (never defaulted to zero)", () => {
  const a: TokenUsage = { inputTokens: 10, outputTokens: 5 };
  const b: TokenUsage = { inputTokens: 20, outputTokens: 7 };

  const sum = tokenUsageAdd(a, b);

  assert.equal(sum.inputTokens, 30);
  assert.equal(sum.cacheReadTokens, undefined);
  assert.equal(sum.reasoningTokens, undefined);
  assert.equal(sum.totalTokens, undefined);
  assert.equal(sum.cacheWriteTokens, undefined);
});

// ---------------------------------------------------------------------------
// Billable input / cache hit rate (TokenUsage derived values)
// ---------------------------------------------------------------------------

test("billableInputTokens = input + cacheRead + cacheWrite (missing → 0)", () => {
  const usage: TokenUsage = { inputTokens: 50, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 100 };

  assert.equal(billableInputTokens(usage), 200);
});

test("billableInputTokens ignores missing cache fields", () => {
  const usage: TokenUsage = { inputTokens: 100, outputTokens: 50 };

  assert.equal(billableInputTokens(usage), 100);
});

test("cacheHitRate = cacheRead ÷ billable input", () => {
  const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 };

  assert.equal(cacheHitRate(usage), 0.9);
});

test("cacheHitRate is zero when no cache read is reported", () => {
  const usage: TokenUsage = { inputTokens: 100, outputTokens: 50 };

  assert.equal(cacheHitRate(usage), 0);
});

test("cacheHitRate includes cacheWrite in the denominator", () => {
  // 计费输入 = 50 + 50 + 100 = 200；命中读取 50 → 25%。
  const usage: TokenUsage = { inputTokens: 50, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 100 };

  assert.equal(cacheHitRate(usage), 0.25);
});

test("cacheHitRate is undefined when there is no billable input (avoids division by zero)", () => {
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  assert.equal(cacheHitRate(usage), undefined);
});

// ---------------------------------------------------------------------------
// CostCalculator (per-million rates, four independent components)
// ---------------------------------------------------------------------------

const RATES = { inputPerMillion: 1.0, outputPerMillion: 2.0, cacheReadPerMillion: 0.2, cacheWritePerMillion: 0.5 };

test("calculateCost with zero usage is zero cost", () => {
  const cost = calculateCost(RATES, tokenUsageZero());

  assert.equal(cost.input, 0);
  assert.equal(cost.output, 0);
  assert.equal(cost.cacheRead, 0);
  assert.equal(cost.cacheWrite, 0);
  assert.equal(usageCostTotal(cost), 0);
});

test("calculateCost applies rates per million tokens", () => {
  // 1,000,000 输入 × $1.00/M = $1.00；1,500,000 输出 × $2.00/M = $3.00。
  const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_500_000 };

  const cost = calculateCost(RATES, usage);

  assert.equal(cost.input, 1.0);
  assert.equal(cost.output, 3.0);
  assert.equal(usageCostTotal(cost), 4.0);
});

test("calculateCost accounts cache tokens at their own (cheaper) rates", () => {
  const usage: TokenUsage = {
    inputTokens: 100_000,
    outputTokens: 50_000,
    cacheReadTokens: 500_000,
    cacheWriteTokens: 200_000,
  };

  const cost = calculateCost(RATES, usage);

  assert.equal(cost.input, 0.1);
  assert.equal(cost.output, 0.1);
  assert.equal(cost.cacheRead, 0.1);
  assert.equal(cost.cacheWrite, 0.1);
  assert.equal(usageCostTotal(cost), 0.4);
});

test("calculateCost treats missing cache tokens as zero", () => {
  const usage: TokenUsage = { inputTokens: 500_000, outputTokens: 500_000 };

  const cost = calculateCost(RATES, usage);

  assert.equal(cost.cacheRead, 0);
  assert.equal(cost.cacheWrite, 0);
  assert.equal(usageCostTotal(cost), 1.5); // 0.5M 输入 × $1 + 0.5M 输出 × $2
});

// ---------------------------------------------------------------------------
// UsageCost aggregation (zero is the identity; Add sums components)
// ---------------------------------------------------------------------------

test("usageCostZero.add(cost) is identity", () => {
  const cost: UsageCost = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };

  const sum = usageCostAdd(usageCostZero(), cost);

  assert.deepEqual(sum, cost);
});

test("usageCostAdd sums all components", () => {
  const a: UsageCost = { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4 };
  const b: UsageCost = { input: 1.0, output: 2.0, cacheRead: 3.0, cacheWrite: 4.0 };

  const sum = usageCostAdd(a, b);

  assert.deepEqual(sum, { input: 1.1, output: 2.2, cacheRead: 3.3, cacheWrite: 4.4 });
});

test("usageCostTotal sums the four components", () => {
  const cost: UsageCost = { input: 0.28, output: 0.42, cacheRead: 0.07, cacheWrite: 0 };

  assert.equal(usageCostTotal(cost), 0.77);
});

// ---------------------------------------------------------------------------
// CombineCost — a missing cost side (unknown rates) is never fabricated as zero
// ---------------------------------------------------------------------------

test("combineCost with unknown cost on either side keeps the known side", () => {
  const known: UsageCost = { input: 0.28, output: 0.42, cacheRead: 0.07, cacheWrite: 0 };

  assert.deepEqual(combineCost(undefined, known), known);
  assert.deepEqual(combineCost(known, undefined), known);
});

test("combineCost with both sides unknown stays undefined (NOT zero)", () => {
  assert.equal(combineCost(undefined, undefined), undefined);
});

test("combineCost with both sides known sums them", () => {
  // 用二进制精确可表示的分量，避免浮点舍入污染 deepEqual 断言。
  const a: UsageCost = { input: 0.25, output: 0.5, cacheRead: 0.75, cacheWrite: 0 };
  const b: UsageCost = { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 };

  const sum = combineCost(a, b);

  assert.deepEqual(sum, { input: 1.25, output: 2.5, cacheRead: 3.75, cacheWrite: 0 });
});

// ---------------------------------------------------------------------------
// Cost wiring into ModelResponse via the assembler seam
// ---------------------------------------------------------------------------

function runAssembler(
  chunks: readonly ProviderChunk[],
  options: ConstructorParameters<typeof ProviderStreamAssembler>[0],
): ModelEvent {
  const assembler = new ProviderStreamAssembler(options);
  for (const chunk of chunks) {
    assembler.add(chunk);
  }
  return assembler.finish();
}

function textStream(usage: TokenUsage): readonly ProviderChunk[] {
  return [
    { type: "blockStart", index: 0, block: { type: "text" } },
    { type: "textDelta", index: 0, delta: "hi" },
    { type: "blockEnd", index: 0 },
    { type: "usage", usage },
    { type: "finish", reason: { type: "stop" } },
  ];
}

test("assembler populates ModelResponse.cost from the injected cost function", () => {
  const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };
  const event = runAssembler(textStream(usage), {
    model: "deepseek-flash",
    cost: (u) => calculateCost({ inputPerMillion: 0.28, outputPerMillion: 0.42, cacheReadPerMillion: 0.07, cacheWritePerMillion: 0 }, u),
  });

  assert.equal(event.type, "completed");
  const response = event.response;
  assert.deepEqual(response.usage, usage);
  assert.ok(response.cost, "cost must be present when rates are known");
  assert.equal(response.cost?.input, 0.28);
  assert.equal(response.cost?.output, 0.42);
  assert.equal(response.cost?.cacheRead, 0.07);
});

test("assembler omits cost when the cost function returns undefined (unknown cost is NOT zero)", () => {
  const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const event = runAssembler(textStream(usage), {
    model: "gpt-6.1-sol",
    cost: () => undefined, // 无费率：cost 必须保持缺失，不得伪造为零。
  });

  assert.equal(event.type, "completed");
  assert.equal("cost" in event.response, false);
  assert.equal(event.response.cost, undefined);
});
