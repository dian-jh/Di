using Core.Llm;

namespace Core.AgentLoop;

/// <summary>
/// Agent 循环运行事件（日志 / 遥测 / 审计的挂点）。
/// MVP 阶段为可空观察者：不注入则不产生任何事件。
/// </summary>
public interface IAgentLoopObserver
{
    void OnEvent(AgentLoopEvent evt);
}

/// <summary>一次循环运行中产生的观察事件。</summary>
public abstract record AgentLoopEvent
{
    /// <summary>一次模型调用完成（含累计用量与停止原因）。</summary>
    public sealed record TurnCompleted(int Iteration, TokenUsage Usage, FinishReason FinishReason) : AgentLoopEvent;

    /// <summary>一次工具调用开始执行。</summary>
    public sealed record ToolStarted(ToolCallBlock Call) : AgentLoopEvent;

    /// <summary>一次工具调用结束。失败时 <see cref="Observation"/> 是错误观察。</summary>
    public sealed record ToolCompleted(ToolCallBlock Call, string Observation, bool IsError) : AgentLoopEvent;

    /// <summary>模型调用抛出不可重试错误，循环以 <see cref="AgentStopReason.Error"/> 结束。</summary>
    public sealed record RunFailed(LlmFailure Failure) : AgentLoopEvent;
}
