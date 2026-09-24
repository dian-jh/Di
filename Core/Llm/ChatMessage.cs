namespace Core.Llm;

/// <summary>
/// 归一化消息。这是 harness 的历史单元（trajectory），也是会话日志与插件的通用词汇。
/// 适配器单独负责把线格式翻译成这里，反之亦然（DSH：Adapters alone translate provider wire messages）。
///
/// 设计要点：
/// <list type="bullet">
/// <item>推理内容（reasoning）是一等公民 —— 带 tools 的请求必须完整回放它，否则 DeepSeek 400。</item>
/// <item>工具调用与工具结果也是消息 —— 历史可以无损重放，对话中间插入由消息模型支持。</item>
/// </list>
/// </summary>
public abstract record ChatMessage
{
    public abstract ChatRole Role { get; }

    /// <summary>system 消息。</summary>
    public static SystemMessage System(string text) => new(text);

    /// <summary>user 消息：纯文本。</summary>
    public static UserMessage User(string text) => new([new TextBlock(text)]);

    /// <summary>user 消息：内容块序列（文本 / 图片 / 文件）。</summary>
    public static UserMessage User(IEnumerable<IContentBlock> content) => new([.. content]);

    /// <summary>assistant 消息：文本 + 推理链 + 工具调用。</summary>
    public static AssistantMessage Assistant(string? text, string? reasoning = null, IEnumerable<ToolCallBlock>? toolCalls = null)
    {
        var content = new List<IContentBlock>();
        if (!string.IsNullOrEmpty(reasoning))
            content.Add(new ReasoningBlock(reasoning));
        if (!string.IsNullOrEmpty(text))
            content.Add(new TextBlock(text));
        if (toolCalls is not null)
            content.AddRange(toolCalls);
        return new AssistantMessage(content);
    }

    /// <summary>工具结果消息（对应 DSH 的 ToolResultMessage）。</summary>
    public static ToolResultMessage Tool(string toolCallId, string result, bool isError = false) =>
        new(toolCallId, result, isError);
}

/// <summary>system 消息。</summary>
public sealed record SystemMessage(string Text) : ChatMessage
{
    public override ChatRole Role => ChatRole.System;
}

/// <summary>user 消息：文本 / 图片 / 文件块。</summary>
public sealed record UserMessage(IReadOnlyList<IContentBlock> Content) : ChatMessage
{
    public override ChatRole Role => ChatRole.User;
}

/// <summary>assistant 消息：文本 + 推理 + 工具调用块。</summary>
public sealed record AssistantMessage(IReadOnlyList<IContentBlock> Content) : ChatMessage
{
    public override ChatRole Role => ChatRole.Assistant;

    /// <summary>推理链（思考模式）。回放时必须保留。</summary>
    public string? Reasoning => Content.OfType<ReasoningBlock>().Select(r => r.Text).FirstOrDefault();

    public IReadOnlyList<ToolCallBlock> ToolCalls => Content.OfType<ToolCallBlock>().ToList();
}

/// <summary>工具结果消息：响应某次工具调用。</summary>
public sealed record ToolResultMessage(string ToolCallId, string Content, bool IsError = false) : ChatMessage
{
    public override ChatRole Role => ChatRole.Tool;
}

/// <summary>便捷访问消息的可见文本（不含推理）。</summary>
public static class ChatMessageExtensions
{
    public static string GetText(this ChatMessage message) => message switch
    {
        SystemMessage system => system.Text,
        UserMessage user => string.Concat(user.Content.OfType<TextBlock>().Select(t => t.Text)),
        AssistantMessage assistant => string.Concat(assistant.Content.OfType<TextBlock>().Select(t => t.Text)),
        ToolResultMessage tool => tool.Content,
        _ => "",
    };
}