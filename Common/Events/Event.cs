namespace Common.Events;

/// <summary>
/// 事件基类（record：不可变 + 值语义，方便日志与测试断言）。
/// 派生出具体事件，例如：
/// <code>public sealed record TurnCompleted(int Iteration, TokenUsage Usage) : Event;</code>
/// </summary>
public abstract record Event : IEvent
{
    /// <summary>全局唯一事件 ID。</summary>
    public Guid Id { get; init; } = Guid.NewGuid();

    /// <summary>事件产生时间（UTC）。</summary>
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;

    /// <summary>
    /// 关联 ID：把同一次运行 / 请求产生的多个事件串起来。
    /// 日志与 CLI UI 可按它把一段轨迹的事件分组渲染。
    /// </summary>
    public string? CorrelationId { get; init; }
}
