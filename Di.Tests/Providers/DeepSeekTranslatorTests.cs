using System.Text.Json;
using Core.Llm;
using Core.Providers.DeepSeek;

namespace Di.Tests.Providers;

/// <summary>
/// DeepSeek 线格式翻译（P1-⑤ 采样参数透传）：<see cref="GenerateOptions"/> 的
/// top_p / frequency_penalty / presence_penalty 应映射到请求体；未设置的字段
/// <b>不序列化</b>（空数组/空字段会让服务端前缀缓存换 key → 全部 miss）。
/// </summary>
public sealed class DeepSeekTranslatorTests
{
    private static GenerateOptions Options() => new()
    {
        Provider = "deepseek",
        Model = "deepseek-flash",
        Messages = [ChatMessage.User("hi")],
    };

    [Fact]
    public void ToWire_MapsSamplingParams()
    {
        var wire = DeepSeekTranslator.ToWire(Options() with
        {
            TopP = 0.8,
            FrequencyPenalty = 0.5,
            PresencePenalty = -0.2,
        });

        Assert.Equal(0.8, wire.TopP);
        Assert.Equal(0.5, wire.FrequencyPenalty);
        Assert.Equal(-0.2, wire.PresencePenalty);
    }

    [Fact]
    public void ToWire_UnsetSamplingParams_AreNull()
    {
        var wire = DeepSeekTranslator.ToWire(Options());

        Assert.Null(wire.TopP);
        Assert.Null(wire.FrequencyPenalty);
        Assert.Null(wire.PresencePenalty);
    }

    [Fact]
    public void ToWire_UnsetSamplingParams_NotSerialized()
    {
        // 未设置的采样字段不能出现在请求体里（字节稳定前缀 → 服务端前缀缓存可命中）。
        var wire = DeepSeekTranslator.ToWire(Options());

        var json = JsonSerializer.Serialize(wire, DeepSeekJson.Options);

        Assert.DoesNotContain("top_p", json);
        Assert.DoesNotContain("frequency_penalty", json);
        Assert.DoesNotContain("presence_penalty", json);
    }

    [Fact]
    public void ToWire_ExistingFields_StillMapped()
    {
        var wire = DeepSeekTranslator.ToWire(Options() with { Temperature = 0.7, MaxTokens = 2048 });

        Assert.Equal(0.7, wire.Temperature);
        Assert.Equal(2048, wire.MaxTokens);
    }
}
