namespace Common.Events;

/// <summary>
/// 进程内事件总线（参考微软 eShopOnContainers / .NET 官方事件总线模型）。
///
/// 提供两种事件消费方式，各自独立、互不影响：
/// 1. 订阅（push）：<see cref="Subscribe{TEvent}(IEventHandler{TEvent})"/> —— 每个订阅者收到每条事件（fan-out），
///    适合日志、安全、遥测等"旁路观察"。
/// 2. 消费（pull）：<see cref="CreateConsumer{TEvent}"/> + await foreach —— 拉取有序事件流，
///    适合 CLI UI 渲染这类"按序处理 + 背压"的消费者。
///
/// 多态派发：事件沿继承链向上投递，订阅 / 消费基类（如 AgentLoopEvent）或接口（如 <see cref="IEvent"/>）
/// 会收到其所有具体子类事件，因此"消费基类一条流、按序收全部事件"成立；具体类型订阅者仍只收自己的类型。
/// 注意：同一处理器同时注册在具体类型和其基类两层时，会收到两次事件——请只订阅在最需要的层级。
///
/// 设计约定：
/// - 订阅返回 <see cref="IDisposable"/> 退订令牌，Dispose 即退订（比微软 Unsubscribe 更安全，支持作用域订阅）。
/// - <see cref="PublishAsync{TEvent}"/> 并发派发并等待所有订阅者完成：保证测试确定性、错误可见；
///   调用方不关心完成与否时可 fire-and-forget（_ = bus.PublishAsync(e)）。
/// - 异常隔离：单个订阅者抛异常不会中断其它订阅者；未配置错误接收器时，发布结束后抛出订阅者的异常
///   （单个失败解包为原始异常，多个失败聚合为 AggregateException），配置了则转发给错误接收器并吞掉
///   （见 <see cref="EventBusOptions.OnHandlerError"/>）。
/// </summary>
public interface IEventBus
{
    /// <summary>发布事件：并发派发给所有订阅者并等待完成，同时入队给所有消费者。</summary>
    Task PublishAsync<TEvent>(TEvent @event, CancellationToken cancellationToken = default) where TEvent : IEvent;

    /// <summary>按处理器类型订阅（微软官方签名）。优先从构造时传入的 <see cref="IServiceProvider"/> 解析，否则无参构造。</summary>
    IDisposable Subscribe<TEvent, THandler>()
        where TEvent : IEvent
        where THandler : IEventHandler<TEvent>;

    /// <summary>订阅一个处理器实例。</summary>
    IDisposable Subscribe<TEvent>(IEventHandler<TEvent> handler) where TEvent : IEvent;

    /// <summary>订阅一个委托处理器（最轻量，适合测试与 CLI 内联逻辑）。</summary>
    IDisposable Subscribe<TEvent>(Func<TEvent, CancellationToken, Task> handler) where TEvent : IEvent;

    /// <summary>创建某事件类型的消费者（pull 模式）：用 await foreach 或 <see cref="IEventConsumer{TEvent}.TryRead"/> 读取该类事件的有序流。</summary>
    IEventConsumer<TEvent> CreateConsumer<TEvent>() where TEvent : class, IEvent;
}
