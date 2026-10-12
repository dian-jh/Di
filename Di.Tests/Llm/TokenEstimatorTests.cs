using Core.Llm;

namespace Di.Tests.Llm;

/// <summary>token 估算（约 4 字符/token，用于上下文预算，不做精确计费）。</summary>
public sealed class TokenEstimatorTests
{
    [Fact]
    public void Estimate_NullAndEmpty_AreZero()
    {
        Assert.Equal(0, TokenEstimator.Estimate(null));
        Assert.Equal(0, TokenEstimator.Estimate(""));
    }

    [Fact]
    public void Estimate_RoughlyFourCharsPerToken()
    {
        Assert.Equal(1, TokenEstimator.Estimate("abcd"));        // 4 字符 → 1
        Assert.Equal(2, TokenEstimator.Estimate("abcdefgh"));    // 8 字符 → 2
        Assert.Equal(3, TokenEstimator.Estimate("abcdefghij"));  // 10 字符 → ceil(2.5) = 3
    }
}
