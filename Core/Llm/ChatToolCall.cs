namespace Core.Llm;

/// <summary>
/// 一次工具调用。DSH 义务：#27 —— 全程原始 JSON 字符串，不解析。
/// </summary>
public sealed class ChatToolCall
{
    /// <summary>工具调用 ID，回填 tool 结果时必须原样带回。</summary>
    public required string Id { get; init; }

    public required string Name { get; init; }

    /// <summary>模型生成的参数，<b>原始 JSON 字符串</b>，调用前必须自行校验。</summary>
    public required string Arguments { get; init; }

    public override string ToString() => $"{Name}({Arguments})";
}
