namespace Core.Llm;

/// <summary>
/// 模型抽象层的<b>消费者入口</b>（对应你评论里的 <c>IChatModel</c>）。
///
/// Agent Loop 只依赖这个接口，不依赖注册表/插件/具体厂商。
/// 用法就是你说的：<c>var model = new ChatModelClient(llm, "deepseek", "deepseek-v4-pro"); var agent = new Agent(model);</c>
///
/// 设计要点：
/// <list type="bullet">
/// <item>模型（Provider+Model）在构造时绑定，所以请求里不再带 provider/model —— 这正是
/// "构造一个模型，把模型交给 Agent"的用法。</item>
/// <item>流式是<b>一等公民</b>：<see cref="StreamAsync"/> 返回事件流，非流式
/// <see cref="CompleteAsync"/> 只是它的聚合。</item>
/// </list>
/// </summary>
public interface IChatModel
{
    /// <summary>非流式：聚合 <see cref="StreamAsync"/> 得到完整响应。</summary>
    Task<ModelResponse> CompleteAsync(ModelRequest request, CancellationToken cancellationToken = default);

    /// <summary>流式：逐事件产出（文本/推理/工具调用/用量/完成）。</summary>
    IAsyncEnumerable<ModelEvent> StreamAsync(ModelRequest request, CancellationToken cancellationToken = default);
}

/// <summary>一次请求（不含 provider/model，它们在模型实例上绑定）。</summary>
public sealed record ModelRequest
{
    public string? SessionId { get; init; }
    public required IReadOnlyList<ChatMessage> Messages { get; init; }

    public IReadOnlyList<ChatTool>? Tools { get; init; }

    /// <summary>推理强度（不透明 ID，值域由适配器声明）。</summary>
    public string? ReasoningEffort { get; init; }

    public double? Temperature { get; init; }

    /// <summary>核采样（top_p）。未设置由适配器缺省。</summary>
    public double? TopP { get; init; }

    /// <summary>频率惩罚。未设置由适配器缺省。</summary>
    public double? FrequencyPenalty { get; init; }

    /// <summary>存在惩罚。未设置由适配器缺省。</summary>
    public double? PresencePenalty { get; init; }

    public int? MaxTokens { get; init; }

    public IReadOnlyList<string>? Stop { get; init; }
}

/// <summary>一次完整响应。</summary>
public sealed class ModelResponse
{
    public required AssistantMessage Message { get; init; }

    public required FinishReason FinishReason { get; init; }

    public TokenUsage Usage { get; init; } = TokenUsage.Zero;

    /// <summary>实际被调用的模型 ID（用于日志）。</summary>
    public string Model { get; init; } = "";

    /// <summary>按模型目录费率折算的成本（目录无费率时为 null）。</summary>
    public UsageCost? Cost { get; init; }

    /// <summary>提供方响应标识（用于追溯/日志；适配器未上报时为空）。</summary>
    public string? ResponseId { get; init; }

    /// <summary>请求开始的 Unix 毫秒时间戳。</summary>
    public long Timestamp { get; init; }

    /// <summary>请求耗时（毫秒，单调时钟）。</summary>
    public long? DurationMs { get; init; }
}

/// <summary>
/// 流式事件（对应你评论里列的那几个）。
/// <c>Completed</c> 携带装配好的完整响应，工具参数碎片拼接已在上游完成，
/// 所以上层只需要在 <c>Completed</c> 拿结果。
/// </summary>
public abstract record ModelEvent
{
    public sealed record TextDelta(string Text) : ModelEvent;

    /// <summary>推理内容增量（思考模式）。</summary>
    public sealed record ReasoningDelta(string Text) : ModelEvent;

    /// <summary>工具调用增量（用于 UI 提示；参数碎片已拼接为当前累计值）。</summary>
    public sealed record ToolCallDelta(string Id, string Name, string Arguments) : ModelEvent;

    public sealed record Usage(TokenUsage Tokens) : ModelEvent;

    public sealed record Completed(ModelResponse Response) : ModelEvent;
}
