using Core.Llm;

namespace Di.Tests.Llm;

/// <summary>
/// <see cref="TokenUsage.Add"/> 的聚合语义：以 <see cref="TokenUsage.Zero"/> 为累加器时，
/// 真实 usage 的缓存命中/推理字段必须保留（identity：Add(Zero, x) == x）。
/// 此前 Zero 的可空字段为 null，会把 x 的 CacheReadTokens/ReasoningTokens 折叠成 null，
/// 导致 ReAct 回合里服务端明明上报了 cached_tokens，UI 却永远显示 cache_read=0。
/// </summary>
public sealed class TokenUsageTests
{
    [Fact]
    public void Zero_Add_RealUsage_KeepsCacheAndReasoning()
    {
        var real = new TokenUsage(1927, 46, CacheReadTokens: 1792, ReasoningTokens: 44);

        var sum = TokenUsage.Zero.Add(real);

        Assert.Equal(1927, sum.InputTokens);
        Assert.Equal(46, sum.OutputTokens);
        Assert.Equal(1792, sum.CacheReadTokens);
        Assert.Equal(44, sum.ReasoningTokens);
    }

    [Fact]
    public void Add_BothSidesNonNull_SumsCacheAndReasoning()
    {
        var a = new TokenUsage(10, 5, CacheReadTokens: 100, ReasoningTokens: 3);
        var b = new TokenUsage(20, 7, CacheReadTokens: 200, ReasoningTokens: 5);

        var sum = a.Add(b);

        Assert.Equal(30, sum.InputTokens);
        Assert.Equal(12, sum.OutputTokens);
        Assert.Equal(300, sum.CacheReadTokens);
        Assert.Equal(8, sum.ReasoningTokens);
    }

    [Fact]
    public void Add_BothNull_StaysNull()
    {
        var a = new TokenUsage(10, 5);
        var b = new TokenUsage(20, 7);

        var sum = a.Add(b);

        Assert.Equal(30, sum.InputTokens);
        Assert.Null(sum.CacheReadTokens);
        Assert.Null(sum.ReasoningTokens);
    }

    [Fact]
    public void ToString_WithCacheRead_ShowsRealValue()
    {
        var usage = new TokenUsage(1927, 46, CacheReadTokens: 1792, ReasoningTokens: 44, TotalTokens: 1973);

        Assert.Contains("cache_read=1792", usage.ToString());
        Assert.Contains("reasoning=44", usage.ToString());
    }

    // ---- CacheHitRate：命中读取 ÷ 计费输入（input + cache_read + cache_write） ----

    [Fact]
    public void CacheHitRate_WithCacheRead_ComputesShareOfBillableInput()
    {
        var usage = new TokenUsage(InputTokens: 100, OutputTokens: 50, CacheReadTokens: 900);

        Assert.Equal(0.9, usage.CacheHitRate!.Value, precision: 10);
    }

    [Fact]
    public void CacheHitRate_NoCacheRead_IsZero()
    {
        var usage = new TokenUsage(InputTokens: 100, OutputTokens: 50);

        Assert.Equal(0, usage.CacheHitRate!.Value, precision: 10);
    }

    [Fact]
    public void CacheHitRate_IncludesCacheWriteInDenominator()
    {
        // 计费输入 = 50 + 50 + 100 = 200；命中读取 50 → 25%
        var usage = new TokenUsage(InputTokens: 50, OutputTokens: 10, CacheReadTokens: 50, CacheWriteTokens: 100);

        Assert.Equal(0.25, usage.CacheHitRate!.Value, precision: 10);
    }

    [Fact]
    public void CacheHitRate_NoInput_IsNull()
    {
        var usage = new TokenUsage(0, 0);

        Assert.Null(usage.CacheHitRate);
    }
}
