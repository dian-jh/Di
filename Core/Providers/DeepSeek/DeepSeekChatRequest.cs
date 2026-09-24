using System.Text.Json.Serialization;

namespace Core.Providers.DeepSeek;

/// <summary>
/// DeepSeek 对话补全请求（线格式 DTO）。provider 内部的传输层对象。
///
/// 序列化注意（都是实测踩过的坑）：
/// <list type="bullet">
/// <item>集合用「可空 + 惰性创建」，未设置时<b>完全不出现</b>在请求体里 —— 否则请求体多一个
/// <c>"stop":[]</c> 就把服务端前缀缓存换成一个新的 key → 全部 cache miss。</item>
/// <item><c>bool?</c> 不能写 false：<c>WhenWritingNull</c> 管不住 false，会把 <c>"strict":false</c>
/// 发出去。默认值必须用 null 表示"不指定"。</item>
/// </list>
/// </summary>
internal sealed class DeepSeekChatRequest
{
    public required List<DeepSeekMessage> Messages { get; set; }

    public required string Model { get; set; }

    public DeepSeekThinking? Thinking { get; set; }

    public int? MaxTokens { get; set; }

    public DeepSeekResponseFormat? ResponseFormat { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public List<string>? Stop { get; set; }

    public bool? Stream { get; set; }

    public DeepSeekStreamOptions? StreamOptions { get; set; }

    public double? Temperature { get; set; }

    public double? TopP { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public List<DeepSeekTool>? Tools { get; set; }

    [JsonConverter(typeof(DeepSeekToolChoiceConverter))]
    public DeepSeekToolChoice? ToolChoice { get; set; }

    public bool? Logprobs { get; set; }

    public int? TopLogprobs { get; set; }

    public string? UserId { get; set; }
}

internal sealed class DeepSeekThinking
{
    public string? Type { get; set; }

    /// <summary>none / low / high / max。disabled 时不应传值。</summary>
    public string? ReasoningEffort { get; set; }
}

internal sealed class DeepSeekResponseFormat
{
    public required string Type { get; set; }
}

internal sealed class DeepSeekStreamOptions
{
    public bool? IncludeUsage { get; set; }
}

internal sealed class DeepSeekTool
{
    public string Type { get; set; } = DeepSeekDefaults.ToolTypes.Function;

    public required DeepSeekFunction Function { get; set; }
}

internal sealed class DeepSeekFunction
{
    public required string Name { get; set; }

    public string? Description { get; set; }

    public object? Parameters { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Strict { get; set; }
}

internal sealed class DeepSeekMessage
{
    public required string Role { get; set; }

    /// <summary>string 或内容块数组。</summary>
    public object? Content { get; set; }

    public string? Name { get; set; }

    /// <summary>仅 assistant：思考链。带 tools 时必须完整回传（否则 400），由翻译层统一强制。</summary>
    public string? ReasoningContent { get; set; }

    public List<DeepSeekToolCall>? ToolCalls { get; set; }

    public string? ToolCallId { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Prefix { get; set; }
}

/// <summary>
/// tool_choice：string 或 {type,function:{name}}。自定义 converter。
/// </summary>
internal sealed class DeepSeekToolChoice
{
    internal string? Mode { get; init; }
    internal string? FunctionName { get; init; }

    public static DeepSeekToolChoice None { get; } = new() { Mode = DeepSeekDefaults.ToolChoices.None };
    public static DeepSeekToolChoice Auto { get; } = new() { Mode = DeepSeekDefaults.ToolChoices.Auto };
    public static DeepSeekToolChoice Required { get; } = new() { Mode = DeepSeekDefaults.ToolChoices.Required };

    public static DeepSeekToolChoice Function(string name) => new() { FunctionName = name };
}
