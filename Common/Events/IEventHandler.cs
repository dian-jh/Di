namespace Common.Events;

/// <summary>
/// 事件处理器（push 模式）：实现它并注册到总线，每收到一条事件调用一次。
/// 也可以不写类，直接用委托订阅（见 <see cref="IEventBus.Subscribe{TEvent}(Func{TEvent, CancellationToken, Task})"/>）。
/// </summary>
public interface IEventHandler<in TEvent> where TEvent : IEvent
{
    Task HandleAsync(TEvent @event, CancellationToken cancellationToken = default);
}
