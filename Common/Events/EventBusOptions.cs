namespace Common.Events;

/// <summary>事件总线配置。</summary>
public sealed class EventBusOptions
{
    /// <summary>
    /// 处理器失败时的接收器。设置后：单个订阅者抛出的异常被隔离并转发到这里，PublishAsync 不再抛出。
    /// 不设置：异常隔离仍然生效（其它订阅者照常执行），但 PublishAsync 结束后会抛出订阅者的异常
    /// （单个失败解包为原始异常，多个失败聚合为 AggregateException）。
    /// 典型用途：把处理器失败记入日志 / 遥测，不让一个坏订阅者打垮 Agent 循环或 CLI UI。
    /// 注：发布方主动取消（OperationCanceledException）不受此接收器接管，始终向上传播。
    /// </summary>
    public Func<Exception, IEvent, Task>? OnHandlerError { get; set; }
}
