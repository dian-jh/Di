using Core.Llm;

namespace Core.AgentLoop;

/// <summary>一次 loop 运行的结局。</summary>
public sealed class AgentResult
{
    /// <summary>最终可见文本（取最后一个 assistant 消息；未收敛时为部分文本或空）。</summary>
    public required string Answer { get; init; }

    /// <summary>完整轨迹（system+user+assistant+tool 消息）—— 可重放的状态。</summary>
    public required IReadOnlyList<ChatMessage> Trajectory { get; init; }

    /// <summary>全部模型调用的累计 token 用量。</summary>
    public TokenUsage Usage { get; init; } = TokenUsage.Zero;

    /// <summary>实际执行的循环轮数。</summary>
    public required int Iterations { get; init; }

    /// <summary>停止原因。</summary>
    public required AgentStopReason StopReason { get; init; }

    /// <summary>当 <see cref="StopReason"/> 为 <see cref="AgentStopReason.Error"/> 时携带故障事实。</summary>
    public LlmFailure? Failure { get; init; }
}

/// <summary>loop 停止的原因。</summary>
public enum AgentStopReason
{
    /// <summary>模型给出最终回答，没有工具调用。</summary>
    Answer,

    /// <summary>模型调用了最终输出工具（参数即答案）。</summary>
    FinalOutputTool,

    /// <summary>达到循环上限仍未收敛。</summary>
    MaxIterations,

    /// <summary>模型调用抛出不可重试的错误。</summary>
    Error,
}
