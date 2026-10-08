using Common.Events;
using Core.Llm;

namespace Core.AgentLoop;

/// <summary>
/// 一次循环运行中产生的观察事件（经事件总线派发，供日志 / 遥测 / CLI UI 订阅或消费）。
/// 继承 <see cref="Event"/> 获得 Id / 创建时间 / 关联 ID，可按基类订阅或消费（多态派发）。
/// </summary>
public abstract record AgentLoopEvent : Event
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
