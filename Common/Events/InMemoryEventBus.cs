using System.Collections.Concurrent;
using System.Threading.Channels;
using Microsoft.Extensions.DependencyInjection;

namespace Common.Events;

/// <summary>
/// 进程内内存事件总线（线程安全）。
/// 订阅与消费按事件类型及其祖先类型索引（多态派发）：发布 TurnCompleted 时，
/// 会沿继承链向上投递给 AgentLoopEvent / Event / IEvent 的订阅与消费，
/// 因此"消费基类一条流、按序收全部事件"成立。向上派发以发布时的静态类型为天花板。
/// 发布时在锁内取快照，锁外并发派发，避免长时间持锁。
/// 事件要么走 push（订阅者回调），要么走 pull（消费者通道），两者独立共存。
/// </summary>
public sealed class InMemoryEventBus : IEventBus
{
    /// <summary>按事件类型缓存其继承链（自身 → 基类 → 接口），避免每次发布重复反射。</summary>
    private static readonly ConcurrentDictionary<Type, Type[]> TypeChainCache = new();

    private readonly object _sync = new();
    private readonly Dictionary<Type, List<IEventSubscriptionSink>> _subscriptions = new();
    private readonly Dictionary<Type, List<IEventChannelSink>> _consumers = new();
    private readonly EventBusOptions _options;
    private readonly IServiceProvider? _serviceProvider;

    public InMemoryEventBus(EventBusOptions? options = null, IServiceProvider? serviceProvider = null)
    {
        _options = options ?? new EventBusOptions();
        _serviceProvider = serviceProvider;
    }

    public async Task PublishAsync<TEvent>(TEvent @event, CancellationToken cancellationToken = default)
        where TEvent : IEvent
    {
        ArgumentNullException.ThrowIfNull(@event);

        IEventSubscriptionSink[] subscriptions;
        IEventChannelSink[] consumers;
        lock (_sync)
        {
            subscriptions = Collect(_subscriptions, typeof(TEvent)).ToArray();
            consumers = Collect(_consumers, typeof(TEvent)).ToArray();
        }

        // pull 模式：入队给消费者（无阻塞，带背压的通道）
        foreach (var consumer in consumers)
            consumer.TryWrite(@event);

        // push 模式：并发派发；InvokeSafelyAsync 逐个隔离异常，
        // 未配置错误接收器时 Task.WhenAll 在全部执行完后抛出订阅者的异常（单个解包、多个聚合）。
        var tasks = subscriptions
            .Select(s => InvokeSafelyAsync(s, @event, cancellationToken))
            .ToArray();
        await Task.WhenAll(tasks).ConfigureAwait(false);
    }

    public IDisposable Subscribe<TEvent, THandler>()
        where TEvent : IEvent
        where THandler : IEventHandler<TEvent>
    {
        var handler = _serviceProvider?.GetService(typeof(THandler)) as IEventHandler<TEvent>
            ?? (IEventHandler<TEvent>)Activator.CreateInstance(typeof(THandler))!;   // DI 解析不到时退化为无参构造
        return Subscribe(handler);
    }

    public IDisposable Subscribe<TEvent>(IEventHandler<TEvent> handler)
        where TEvent : IEvent
    {
        ArgumentNullException.ThrowIfNull(handler);
        var subscription = new Subscription<TEvent>(handler);
        lock (_sync)
            GetOrCreate(_subscriptions, typeof(TEvent)).Add(subscription);
        return new SubscriptionToken<TEvent>(subscription, Remove);
    }

    public IDisposable Subscribe<TEvent>(Func<TEvent, CancellationToken, Task> handler)
        where TEvent : IEvent
    {
        ArgumentNullException.ThrowIfNull(handler);
        return Subscribe<TEvent>(new DelegateEventHandler<TEvent>(handler));
    }

    public IEventConsumer<TEvent> CreateConsumer<TEvent>()
        where TEvent : IEvent
    {
        var sink = new ChannelSink<TEvent>();
        lock (_sync)
            GetOrCreate(_consumers, typeof(TEvent)).Add(sink);
        return new Consumer<TEvent>(sink, () => RemoveConsumer(typeof(TEvent), sink));
    }

    private async Task InvokeSafelyAsync(IEventSubscriptionSink subscription, IEvent @event, CancellationToken ct)
    {
        try
        {
            await subscription.HandleAsync(@event, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;   // 发布方主动取消：保持传播，不交给错误接收器
        }
        catch (Exception ex) when (_options.OnHandlerError is not null)
        {
            await _options.OnHandlerError(ex, @event).ConfigureAwait(false);
        }
    }

    private void Remove<TEvent>(Subscription<TEvent> subscription)
        where TEvent : IEvent
    {
        lock (_sync)
        {
            if (_subscriptions.TryGetValue(typeof(TEvent), out var list) && list.Remove(subscription) && list.Count == 0)
                _subscriptions.Remove(typeof(TEvent));
        }
    }

    private void RemoveConsumer(Type eventType, IEventChannelSink sink)
    {
        lock (_sync)
        {
            if (_consumers.TryGetValue(eventType, out var list) && list.Remove(sink) && list.Count == 0)
                _consumers.Remove(eventType);
        }
    }

    private static List<T> GetOrCreate<T>(Dictionary<Type, List<T>> map, Type key)
    {
        if (!map.TryGetValue(key, out var list))
            map[key] = list = [];
        return list;
    }

    /// <summary>沿事件类型的继承链，收集各级已注册的订阅 / 消费者。</summary>
    private static List<T> Collect<T>(Dictionary<Type, List<T>> map, Type eventType)
    {
        var result = new List<T>();
        foreach (var type in GetTypeChain(eventType))
            if (map.TryGetValue(type, out var list))
                result.AddRange(list);
        return result;
    }

    /// <summary>计算继承链：自身 → 各基类（不含 object）→ 所有接口。</summary>
    private static Type[] GetTypeChain(Type eventType)
        => TypeChainCache.GetOrAdd(eventType, static t =>
        {
            var chain = new List<Type>(4);
            for (var current = t; current is not null && current != typeof(object); current = current.BaseType)
                chain.Add(current);
            chain.AddRange(t.GetInterfaces());
            return chain.ToArray();
        });

    /// <summary>订阅槽的隐藏类型：把泛型处理器收窄成非泛型调用，避免字典里用反射。</summary>
    private interface IEventSubscriptionSink
    {
        Task HandleAsync(IEvent @event, CancellationToken cancellationToken);
    }

    private sealed class Subscription<TEvent> : IEventSubscriptionSink where TEvent : IEvent
    {
        private readonly IEventHandler<TEvent> _handler;
        public Subscription(IEventHandler<TEvent> handler) => _handler = handler;
        public Task HandleAsync(IEvent @event, CancellationToken ct) => _handler.HandleAsync((TEvent)@event, ct);
    }

    private sealed class DelegateEventHandler<TEvent> : IEventHandler<TEvent> where TEvent : IEvent
    {
        private readonly Func<TEvent, CancellationToken, Task> _handler;
        public DelegateEventHandler(Func<TEvent, CancellationToken, Task> handler) => _handler = handler;
        public Task HandleAsync(TEvent @event, CancellationToken ct) => _handler(@event, ct);
    }

    /// <summary>消费者通道的隐藏类型：把泛型 Channel&lt;TEvent&gt; 与发布路径解耦。</summary>
    private interface IEventChannelSink
    {
        void TryWrite(IEvent @event);
    }

    private sealed class ChannelSink<TEvent> : IEventChannelSink where TEvent : IEvent
    {
        public Channel<TEvent> InnerChannel { get; } = Channel.CreateUnbounded<TEvent>();
        public void TryWrite(IEvent @event) => InnerChannel.Writer.TryWrite((TEvent)@event);
    }

    /// <summary>退订令牌：Dispose 即退订，幂等。</summary>
    private sealed class SubscriptionToken<TEvent> : IDisposable where TEvent : IEvent
    {
        private readonly Subscription<TEvent> _subscription;
        private readonly Action<Subscription<TEvent>> _remove;
        private int _disposed;

        public SubscriptionToken(Subscription<TEvent> subscription, Action<Subscription<TEvent>> remove)
        {
            _subscription = subscription;
            _remove = remove;
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 1)
                return;
            _remove(_subscription);
        }
    }

    /// <summary>消费者句柄：Dispose 时完成通道并退订，幂等。</summary>
    private sealed class Consumer<TEvent> : IEventConsumer<TEvent> where TEvent : IEvent
    {
        private readonly ChannelSink<TEvent> _sink;
        private readonly Action _remove;
        private int _disposed;

        public Consumer(ChannelSink<TEvent> sink, Action remove)
        {
            _sink = sink;
            _remove = remove;
        }

        public IAsyncEnumerable<TEvent> ConsumeAsync(CancellationToken cancellationToken = default)
            => _sink.InnerChannel.Reader.ReadAllAsync(cancellationToken);

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 1)
                return;
            _sink.InnerChannel.Writer.TryComplete();
            _remove();
        }
    }
}
