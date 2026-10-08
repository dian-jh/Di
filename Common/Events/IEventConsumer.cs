namespace Common.Events;

/// <summary>
/// 消费者（pull 模式）：从总线拉取某类事件的有序流。
/// 与订阅（push 回调）相对；多个消费者互不竞争，各自收到每一条事件。
/// 多态派发：消费基类（如 AgentLoopEvent）会收到其所有具体子类事件，顺序与发布顺序一致。
/// 典型用途：CLI UI 渲染层用 await foreach 消费 AgentLoopEvent，天然带顺序与背压。
/// 用完后务必 <see cref="IDisposable.Dispose"/> 退订，避免通道泄漏。
/// </summary>
public interface IEventConsumer<out TEvent> : IDisposable where TEvent : class, IEvent
{
    /// <summary>消费事件流；枚举直到 <paramref name="cancellationToken"/> 取消或消费者被 Dispose。</summary>
    IAsyncEnumerable<TEvent> ConsumeAsync(CancellationToken cancellationToken = default);

    /// <summary>
    /// 非阻塞读取一条已缓冲的事件；无则返回 null。
    /// 用于回合边界排空：一次运行结束后把本回合全部事件取走，不等待新事件（配合顺序渲染）。
    /// </summary>
    TEvent? TryRead();
}
