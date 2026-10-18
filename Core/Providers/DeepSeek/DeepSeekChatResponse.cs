using System.Text.Json;
using System.Text.Json.Serialization;

namespace Core.Providers.DeepSeek;

/// <summary>
/// DeepSeek 非流式响应与流式 chunk（线格式 DTO）。
/// 字段名依赖 <see cref="DeepSeekJson"/> 的 snake_case 自动映射。
/// </summary>
internal sealed class DeepSeekChatResponse
{
    public string? Id { get; set; }
    public List<DeepSeekChatChoice>? Choices { get; set; }
    public long Created { get; set; }
    public string? Model { get; set; }
    public string? SystemFingerprint { get; set; }
    public string? Object { get; set; }
    public DeepSeekUsage? Usage { get; set; }
}

internal sealed class DeepSeekChatChoice
{
    public string? FinishReason { get; set; }
    public int Index { get; set; }
    public DeepSeekAssistantMessage? Message { get; set; }
}

internal sealed class DeepSeekAssistantMessage
{
    public string? Content { get; set; }
    public string? ReasoningContent { get; set; }
    public List<DeepSeekToolCall>? ToolCalls { get; set; }
    public string? Role { get; set; }
}

internal sealed class DeepSeekToolCall
{
    public string? Id { get; set; }
    public string? Type { get; set; }
    public int? Index { get; set; }
    public DeepSeekFunctionCall? Function { get; set; }
}

internal sealed class DeepSeekFunctionCall
{
    public string? Name { get; set; }
    public string? Arguments { get; set; }
}

internal sealed class DeepSeekUsage
{
    public int CompletionTokens { get; set; }
    public int PromptTokens { get; set; }
    public int? TotalTokens { get; set; }

    /// <summary>顶层字段（官方线格式）：命中上下文缓存的 prompt token 数。</summary>
    public int? PromptCacheHitTokens { get; set; }

    /// <summary>顶层字段（官方线格式）：未命中缓存的 prompt token 数。</summary>
    public int? PromptCacheMissTokens { get; set; }

    public DeepSeekPromptTokensDetails? PromptTokensDetails { get; set; }
    public DeepSeekCompletionTokensDetails? CompletionTokensDetails { get; set; }
}

/// <summary>OpenAI 风格嵌套对象：只含 cached_tokens（与顶层 prompt_cache_hit_tokens 同值）。</summary>
internal sealed class DeepSeekPromptTokensDetails
{
    public int? CachedTokens { get; set; }
}

internal sealed class DeepSeekCompletionTokensDetails
{
    public int? ReasoningTokens { get; set; }
}

/// <summary>流式 chunk。usage 只出现在最后一个 chunk（配合 include_usage）。</summary>
internal sealed class DeepSeekChatChunk
{
    public string? Id { get; set; }
    public List<DeepSeekChunkChoice>? Choices { get; set; }
    public long Created { get; set; }
    public string? Model { get; set; }
    public string? SystemFingerprint { get; set; }
    public string? Object { get; set; }
    public DeepSeekUsage? Usage { get; set; }
}

internal sealed class DeepSeekChunkChoice
{
    public DeepSeekDelta? Delta { get; set; }
    public string? FinishReason { get; set; }
    public int? Index { get; set; }
}

internal sealed class DeepSeekDelta
{
    public string? Content { get; set; }
    public string? ReasoningContent { get; set; }
    public string? Role { get; set; }
    public List<DeepSeekToolCall>? ToolCalls { get; set; }
}

internal sealed class DeepSeekToolChoiceConverter : JsonConverter<DeepSeekToolChoice>
{
    public override DeepSeekToolChoice? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.String)
            return new DeepSeekToolChoice { Mode = reader.GetString() };

        if (reader.TokenType == JsonTokenType.StartObject)
        {
            using var document = JsonDocument.ParseValue(ref reader);
            if (document.RootElement.TryGetProperty("function", out var function) &&
                function.TryGetProperty("name", out var name) &&
                name.ValueKind == JsonValueKind.String)
            {
                return DeepSeekToolChoice.Function(name.GetString()!);
            }
        }

        return null;
    }

    public override void Write(Utf8JsonWriter writer, DeepSeekToolChoice value, JsonSerializerOptions options)
    {
        if (value.Mode is not null)
        {
            writer.WriteStringValue(value.Mode);
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("type", DeepSeekDefaults.ToolTypes.Function);
        writer.WriteStartObject("function");
        writer.WriteString("name", value.FunctionName);
        writer.WriteEndObject();
        writer.WriteEndObject();
    }
}
