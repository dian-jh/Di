using Common.Events;
using Core.Llm;

namespace Core.AgentLoop;

/// <summary>
/// 一次循环运行中产生的观察事件（经事件总线派发，供日志 / 遥测 / CLI UI 订阅或消费）。
/// 继承 <see cref="Event"/> 获得 Id / 创建时间 / 关联 ID，可按基类订阅或消费（多态派发）。
/// </summary>
public abstract record AgentLoopEvent : Event
{
    /// <summary>流式文本增量（模型逐字输出）。UI 据此实时渲染，日志可据此做逐字遥测。</summary>
    public sealed record TextDelta(string Delta) : AgentLoopEvent;

    /// <summary>
    /// 推理内容增量（思考模式，逐段转发自 <see cref="ModelEvent.ReasoningDelta"/>）。
    /// M1 新增：TUI 据此展示思考过程；既有文本渲染器（EventRenderer）对未知类型天然忽略。
    /// </summary>
    public sealed record ReasoningDelta(string Delta) : AgentLoopEvent;

    /// <summary>
    /// 工具调用增量（逐段转发自 <see cref="ModelEvent.ToolCallDelta"/>）。
    /// <see cref="Arguments"/> 为迄今累计的原始 JSON 串，可能尚未完成；UI 据此实时展示工具调用。
    /// 名为 <c>ToolCallId</c> 而非 <c>Id</c>：基类 <see cref="Event.Id"/> 已是 Guid，位置参数不能与之重名。
    /// </summary>
    public sealed record ToolCallDelta(string ToolCallId, string Name, string Arguments) : AgentLoopEvent;

    /// <summary>一次模型调用完成（含累计用量、累计成本与停止原因）。</summary>
    public sealed record TurnCompleted(int Iteration, TokenUsage Usage, UsageCost? Cost, FinishReason FinishReason) : AgentLoopEvent;

    /// <summary>一次工具调用开始执行。</summary>
    public sealed record ToolStarted(ToolCallBlock Call) : AgentLoopEvent;

    /// <summary>一次工具调用结束。失败时 <see cref="Observation"/> 是错误观察。</summary>
    public sealed record ToolCompleted(ToolCallBlock Call, string Observation, bool IsError) : AgentLoopEvent;

    /// <summary>模型调用抛出不可重试错误，循环以 <see cref="AgentStopReason.Error"/> 结束。</summary>
    public sealed record RunFailed(LlmFailure Failure) : AgentLoopEvent;
}
