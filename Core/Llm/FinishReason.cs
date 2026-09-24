namespace Core.Llm;

/// <summary>
/// 可序列化的提供方/传输故障事实。策略决定它是否可重试。
/// 对应 DSH 的 LlmFailure。
/// </summary>
public sealed record LlmFailure(
    string Message,
    string Code,
    int? Status = null,
    TimeSpan? ProviderRetryAfter = null,
    string? RequestId = null);

/// <summary>
/// 模型停止生成的原因。对应 DSH 的 FinishReason 映射。
/// <c>Aborted</c> 与 <c>Error</c> 携带故障事实。
/// </summary>
public abstract record FinishReason
{
    public sealed record Stop : FinishReason;

    public sealed record ToolCalls : FinishReason;

    public sealed record MaxTokens : FinishReason;

    public sealed record Aborted(LlmFailure Failure) : FinishReason;

    public sealed record Error(LlmFailure Failure) : FinishReason;

    public bool IsToolCall => this is ToolCalls;

    public string? Kind => this switch
    {
        Stop => "stop",
        ToolCalls => "tool-calls",
        MaxTokens => "max-tokens",
        Aborted => "aborted",
        Error => "error",
        _ => null,
    };
}
