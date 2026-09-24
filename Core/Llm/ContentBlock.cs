namespace Core.Llm;

/// <summary>
/// 消息内容块（可扩展词汇表）。
///
/// C# 没有 TypeScript 的 <c>declare module</c> 模块增强，因此用"标记接口 + <see cref="ContentBlockRegistry"/>"
/// 实现等价扩展：插件注册新的 <see cref="IContentBlock"/> 类型后，装配器就能使用它；
/// 遇到未知类型时走 <see cref="OpaqueBlock"/> 无损透传 —— 绝不允许丢块（DSH 义务）。
///
/// 注意：这些类型是<b>内存内词汇</b>。发往 provider 的线格式由适配器在翻译层各自负责
/// （每个适配器有自己的扁平 DTO），因此这里不需要通用 JSON 转换器。
/// 历史持久化（session log）需要序列化时，由宿主用类型标签 + 注册表自行实现。
/// </summary>
public interface IContentBlock
{
    /// <summary>块类型标签，也是注册表键。</summary>
    string Type { get; }
}

/// <summary>纯文本。</summary>
public sealed record TextBlock(string Text) : IContentBlock
{
    public string Type => "text";
}

/// <summary>
/// 推理/思考内容，与可见文本分离。harness 必须能原样回放它
/// （DeepSeek 在带 tools 时缺 reasoning_content 会直接 400）。
/// </summary>
public sealed record ReasoningBlock(string Text) : IContentBlock
{
    public string Type => "reasoning";
}

/// <summary>图片引用（durable attachment id）。</summary>
public sealed record ImageBlock(string AttachmentId, string? Detail = null) : IContentBlock
{
    public string Type => "image";
}

/// <summary>文件引用（durable attachment id）。</summary>
public sealed record FileBlock(string AttachmentId, string? Filename = null) : IContentBlock
{
    public string Type => "file";
}

/// <summary>模型请求的工具调用。</summary>
public sealed record ToolCallBlock(string Id, string Name, string Arguments) : IContentBlock
{
    public string Type => "tool-call";
}

/// <summary>工具执行结果，回填给模型。</summary>
public sealed record ToolResultBlock(string ToolCallId, string Content, bool IsError = false) : IContentBlock
{
    public string Type => "tool-result";
}

/// <summary>
/// 逃生舱：插件贡献的未知块类型。harness 不认识但能无损保存与回放。
/// 原始载荷保留为 JSON 字符串，避免依赖 JsonElement 的生命周期问题。
/// </summary>
public sealed record OpaqueBlock(string UnknownType, string RawJson) : IContentBlock
{
    public string Type => UnknownType;
}

/// <summary>内容块注册表：插件在这里贡献新的块类型。</summary>
public sealed class ContentBlockRegistry
{
    private readonly HashSet<string> _types = new(StringComparer.Ordinal);

    public void Register(string type)
    {
        if (!_types.Add(type))
            throw new InvalidOperationException($"内容块类型 '{type}' 已注册。");
    }

    public bool IsKnown(string type) => _types.Contains(type);

    public IReadOnlyCollection<string> KnownTypes => _types;
}
