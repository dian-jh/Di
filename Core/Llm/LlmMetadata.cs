namespace Core.Llm;

/// <summary>
/// 适配器拥有的、有序的不透明推理强度 ID。
/// 对应 DSH 的 LlmReasoningEffortInfo。ID 无需与协议表示相同，
/// 由适配器自行映射到提供方请求（例如 "high" → DeepSeek 的 reasoning_effort: "high"）。
/// </summary>
public sealed record ReasoningEffort(string Id, string Name, string? Description = null);

/// <summary>一个精确 provider/model 路由的推理能力（适配器上报）。</summary>
public sealed record LlmModelReasoningInfo(
    IReadOnlyList<ReasoningEffort> Efforts,
    string? DefaultEffort = null);

/// <summary>一个 provider 路由的展示元数据。</summary>
public sealed record LlmProviderInfo(string Id, string Name);

/// <summary>适配器上报的一个模型（咨询性，不用于请求校验）。</summary>
public sealed record LlmModelInfo(
    string Provider,
    string Id,
    string Name,
    string? Description = null);

/// <summary>一个精确模型路由的上下文容量。</summary>
public sealed record LlmModelContext(int ContextWindow);

/// <summary>精确模型元数据（适配器 resolveModel 返回）。</summary>
public sealed record LlmResolvedModelInfo(
    string Provider,
    string Id,
    string Name,
    LlmModelContext? Context = null,
    int? DefaultMaxTokens = null,
    LlmModelReasoningInfo? Reasoning = null);

/// <summary>一次准备好的调用：元数据与 stream 绑定到同一"代"（热重载竞态防护）。</summary>
public sealed record PreparedAdapterCall(
    LlmResolvedModelInfo Model,
    Func<GenerateOptions, CancellationToken, IAsyncEnumerable<StreamChunk>> Stream);
