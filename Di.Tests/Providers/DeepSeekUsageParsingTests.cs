using System.Text.Json;
using Core.Llm;
using Core.Providers.DeepSeek;

namespace Di.Tests.Providers;

/// <summary>
/// 用 curl 实测抓到的真实线格式 chunk 验证 usage 反序列化——
/// 真实 API 返回里 prompt_cache_hit_tokens / prompt_cache_miss_tokens 是 usage 的
/// <b>顶层字段</b>，而 prompt_tokens_details 里只有 cached_tokens（两者并存）。
/// </summary>
public sealed class DeepSeekUsageParsingTests
{
    // curl 实测（2026-10-09，deepseek-flash，带 tools+thinking）的最后一个 usage chunk。
    private const string RealFinalChunk = /*lang=json*/ """
        {
          "id": "65327d35-3b80-4a5e-b81f-207bb098a43e",
          "object": "chat.completion.chunk",
          "created": 1791525449,
          "model": "deepseek-flash",
          "system_fingerprint": "aeb56401ca74e127821c4f9126dcb669",
          "choices": [{"index": 0, "delta": {"content": "", "reasoning_content": null}, "logprobs": null, "finish_reason": "stop"}],
          "usage": {
            "prompt_tokens": 3291,
            "completion_tokens": 24,
            "total_tokens": 3315,
            "prompt_tokens_details": {"cached_tokens": 3072},
            "completion_tokens_details": {"reasoning_tokens": 22},
            "prompt_cache_hit_tokens": 3072,
            "prompt_cache_miss_tokens": 219
          }
        }
        """;

    [Fact]
    public void Deserialize_RealUsageChunk_ReadsCacheAndReasoning()
    {
        var chunk = JsonSerializer.Deserialize<DeepSeekChatChunk>(RealFinalChunk, DeepSeekJson.Options)!;

        var usage = chunk.Usage!;
        Assert.Equal(3291, usage.PromptTokens);
        Assert.Equal(24, usage.CompletionTokens);
        Assert.Equal(3315, usage.TotalTokens);

        // 官方线格式：prompt_cache_hit_tokens / prompt_cache_miss_tokens 在 usage 顶层。
        Assert.Equal(3072, usage.PromptCacheHitTokens);
        Assert.Equal(219, usage.PromptCacheMissTokens);
        // OpenAI 风格的 cached_tokens 才在 prompt_tokens_details 里。
        Assert.NotNull(usage.PromptTokensDetails);
        Assert.Equal(3072, usage.PromptTokensDetails.CachedTokens);
        Assert.NotNull(usage.CompletionTokensDetails);
        Assert.Equal(22, usage.CompletionTokensDetails.ReasoningTokens);
    }

    [Fact]
    public void ToUsage_MapsRealWire_ToTokenUsage()
    {
        var chunk = JsonSerializer.Deserialize<DeepSeekChatChunk>(RealFinalChunk, DeepSeekJson.Options)!;

        var usage = DeepSeekTranslator.ToUsage(chunk.Usage!);

        Assert.Equal(3072, usage.CacheReadTokens);
        Assert.Equal(22, usage.ReasoningTokens);
        Assert.Equal(219, usage.InputTokens);
    }

    [Fact]
    public void ToUsage_PrefersTopLevelHitTokens_OverNestedCachedTokens()
    {
        // 若两处同时出现（实测如此），以顶层 prompt_cache_hit_tokens 为准。
        var wire = new DeepSeekUsage
        {
            PromptTokens = 1000,
            CompletionTokens = 5,
            TotalTokens = 1005,
            PromptCacheHitTokens = 800,
            PromptTokensDetails = new DeepSeekPromptTokensDetails { CachedTokens = 500 },
        };

        var usage = DeepSeekTranslator.ToUsage(wire);

        Assert.Equal(800, usage.CacheReadTokens);
    }

    [Fact]
    public void ToUsage_UsesPromptCacheMissTokens_AsUncachedInput()
    {
        var usage = DeepSeekTranslator.ToUsage(new DeepSeekUsage
        {
            PromptTokens = 1000,
            PromptCacheHitTokens = 800,
            PromptCacheMissTokens = 200,
        });

        Assert.Equal(200, usage.InputTokens);
        Assert.Equal(800, usage.CacheReadTokens);
        Assert.Equal(1000, usage.BillableInputTokens);
    }

    [Fact]
    public void ToUsage_FallsBackToPromptMinusCacheHit_WhenMissTokensAreMissing()
    {
        var usage = DeepSeekTranslator.ToUsage(new DeepSeekUsage
        {
            PromptTokens = 1000,
            PromptCacheHitTokens = 800,
        });

        Assert.Equal(200, usage.InputTokens);
        Assert.Equal(800, usage.CacheReadTokens);
    }

    [Fact]
    public void ToUsage_CostUsesDisjointUncachedAndCacheReadRates()
    {
        var usage = DeepSeekTranslator.ToUsage(new DeepSeekUsage
        {
            PromptTokens = 1000,
            CompletionTokens = 0,
            PromptCacheHitTokens = 800,
            PromptCacheMissTokens = 200,
        });
        var cost = CostCalculator.Calculate(new ModelCostRates(
            InputPerMillion: 1.00,
            OutputPerMillion: 0,
            CacheReadPerMillion: 0.20), usage);

        Assert.Equal(0.0002, cost.Input, precision: 9);
        Assert.Equal(0.00016, cost.CacheRead, precision: 9);
        Assert.Equal(0.00036, cost.Total, precision: 9);
    }

    [Fact]
    public void ToUsage_MissingTotalTokensPreservesUnknown()
    {
        const string json = """{"usage":{"prompt_tokens":10,"completion_tokens":2}}""";
        var chunk = JsonSerializer.Deserialize<DeepSeekChatChunk>(json, DeepSeekJson.Options)!;

        var usage = DeepSeekTranslator.ToUsage(chunk.Usage!);

        Assert.Null(usage.TotalTokens);
    }

    [Fact]
    public void ToUsage_ExplicitZeroTotalTokensRemainsZero()
    {
        const string json = """{"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}""";
        var chunk = JsonSerializer.Deserialize<DeepSeekChatChunk>(json, DeepSeekJson.Options)!;

        var usage = DeepSeekTranslator.ToUsage(chunk.Usage!);

        Assert.Equal(0, usage.TotalTokens);
    }
}
