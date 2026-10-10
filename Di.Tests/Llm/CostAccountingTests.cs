using Core.Llm;

namespace Di.Tests.Llm;

/// <summary>
/// 成本计量（P0-③）：按每百万 token 单价把 <see cref="TokenUsage"/> 折算成金额。
/// 计费 = Input / Output / CacheRead / CacheWrite 各分量按各自单价折算（缓存命中通常显著便宜），
/// 而非简单地用"计费输入"总数乘一个单价 —— 缓存读比新输入便宜，混算会高估。
/// </summary>
public sealed class CostAccountingTests
{
    private static readonly ModelCostRates Rates = new(
        InputPerMillion: 1.00,
        OutputPerMillion: 2.00,
        CacheReadPerMillion: 0.20,
        CacheWritePerMillion: 0.50);

    [Fact]
    public void Calculate_ZeroUsage_IsZeroCost()
    {
        var cost = CostCalculator.Calculate(Rates, TokenUsage.Zero);

        Assert.Equal(0, cost.Input);
        Assert.Equal(0, cost.Output);
        Assert.Equal(0, cost.CacheRead);
        Assert.Equal(0, cost.CacheWrite);
        Assert.Equal(0, cost.Total);
    }

    [Fact]
    public void Calculate_AppliesRatesPerMillionTokens()
    {
        // 1,000,000 输入 × $1.00/M = $1.00；1,500,000 输出 × $2.00/M = $3.00。
        var usage = new TokenUsage(1_000_000, 1_500_000);

        var cost = CostCalculator.Calculate(Rates, usage);

        Assert.Equal(1.00, cost.Input, precision: 6);
        Assert.Equal(3.00, cost.Output, precision: 6);
        Assert.Equal(4.00, cost.Total, precision: 6);
    }

    [Fact]
    public void Calculate_CacheTokens_UseCacheRates()
    {
        var usage = new TokenUsage(InputTokens: 100_000, OutputTokens: 50_000, CacheReadTokens: 500_000, CacheWriteTokens: 200_000);

        var cost = CostCalculator.Calculate(Rates, usage);

        Assert.Equal(0.10, cost.Input, precision: 6);
        Assert.Equal(0.10, cost.Output, precision: 6);
        Assert.Equal(0.10, cost.CacheRead, precision: 6);
        Assert.Equal(0.10, cost.CacheWrite, precision: 6);
        Assert.Equal(0.40, cost.Total, precision: 6);
    }

    [Fact]
    public void Calculate_MissingCacheTokens_TreatsAsZero()
    {
        // 缓存字段未上报（null）→ 按 0 计，不抛异常。
        var usage = new TokenUsage(InputTokens: 500_000, OutputTokens: 500_000);

        var cost = CostCalculator.Calculate(Rates, usage);

        Assert.Equal(0, cost.CacheRead);
        Assert.Equal(0, cost.CacheWrite);
        Assert.Equal(0.50 + 1.00, cost.Total, precision: 6);   // 0.5M 输入 × $1 + 0.5M 输出 × $2
    }

    [Fact]
    public void Add_SumsAllComponents()
    {
        var a = new UsageCost(0.1, 0.2, 0.3, 0.4);
        var b = new UsageCost(1.0, 2.0, 3.0, 4.0);

        var sum = a.Add(b);

        Assert.Equal(new UsageCost(1.1, 2.2, 3.3, 4.4), sum);
    }

    [Fact]
    public void Zero_Add_IsIdentity()
    {
        var cost = new UsageCost(1, 2, 3, 4);

        Assert.Equal(cost, UsageCost.Zero.Add(cost));
    }
}
