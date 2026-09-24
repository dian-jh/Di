namespace Core.Llm;

/// <summary>
/// 工具定义。目前所有主流厂商都只支持 function 形态，因此直接以 function 建模。
/// 对应 DSH 的 ToolSchema（parameters 是 JSON Schema 对象）。
/// </summary>
public sealed class ChatTool
{
    public required string Name { get; init; }

    public required string Description { get; init; }

    /// <summary>参数的 JSON Schema。</summary>
    public required System.Text.Json.Nodes.JsonObject Parameters { get; init; }

    /// <summary>严格模式：保证输出符合 JSON Schema。部分厂商需要 beta 端点（DeepSeek 需要）。</summary>
    public bool Strict { get; init; }

    public static ChatTool Create(string name, string description, System.Text.Json.Nodes.JsonObject parameters, bool strict = false) =>
        new() { Name = name, Description = description, Parameters = parameters, Strict = strict };
}

/// <summary>
/// 工具选择策略。tool_choice 语义在各厂商间差异较大（且 DeepSeek 思考模式下
/// 不支持 required / 指定函数），因此默认交给适配器处理：
/// 大多数情况用 Auto，适配器按能力决定。
/// </summary>
public abstract record ChatToolChoice
{
    public sealed record Auto : ChatToolChoice;
    public sealed record None : ChatToolChoice;

    /// <summary>强制模型必须调用工具。DeepSeek 思考模式下会 400 —— 由适配器抛 UNSUPPORTED_OPTION。</summary>
    public sealed record Required : ChatToolChoice;

    /// <summary>强制调用指定工具。同上，思考模式下不支持。</summary>
    public sealed record Function(string Name) : ChatToolChoice;

    public static ChatToolChoice AutoChoice { get; } = new Auto();
    public static ChatToolChoice NoneChoice { get; } = new None();
}

/// <summary>
/// 一次完整的模型请求（对应 DSH 的 GenerateOptions）。
///
/// 关键区别（vs 我上一轮的 ChatRequest）：
/// <list type="bullet">
/// <item><c>Provider</c> 与 <c>Model</c> 是<b>两个独立字段</b>，不再拼接成 "deepseek:v4-pro"。</item>
/// <item>推理强度是<b>不透明字符串 ID</b>（由适配器声明值域），不是共享枚举。</item>
/// <item>不支持的值由适配器抛 <see cref="LlmErrorCodes.UnsupportedOption"/>，不静默降级。</item>
/// </list>
/// </summary>
public sealed class GenerateOptions
{
    /// <summary>注册的 provider 路由，选择适配器实例。</summary>
    public required string Provider { get; init; }

    /// <summary>提供方自己的模型 ID。</summary>
    public required string Model { get; init; }

    /// <summary>有序对话消息，与提供方看到的完全一致。</summary>
    public required IReadOnlyList<ChatMessage> Messages { get; init; }

    /// <summary>推理强度（不透明 ID）。由适配器 resolveModel 上报值域。</summary>
    public string? ReasoningEffort { get; init; }

    /// <summary>工具 schema 列表。</summary>
    public IReadOnlyList<ChatTool>? Tools { get; init; }

    public ChatToolChoice ToolChoice { get; init; } = ChatToolChoice.AutoChoice;

    public double? Temperature { get; init; }

    public int? MaxTokens { get; init; }

    /// <summary>停止序列。</summary>
    public IReadOnlyList<string>? Stop { get; init; }

    /// <summary>业务侧用户标识（部分厂商用于缓存/调度隔离）。</summary>
    public string? UserId { get; init; }

    /// <summary>会话标识（回放 / 传输元数据）。</summary>
    public string? SessionId { get; init; }

    public CancellationToken CancellationToken { get; init; }
}
