using System.Collections.Concurrent;
using Common.Events;
using Microsoft.Extensions.DependencyInjection;

namespace Di.Tests;

/// <summary>
/// 针对 <see cref="Common.Events.InMemoryEventBus"/> 的单元测试。
/// 覆盖：订阅派发（实例 / 委托 / 类型）、fan-out、退订、异常隔离与错误接收器、
/// 消费者拉流、线程安全、DI 解析、事件基类字段。
/// </summary>
public sealed class EventBusTests
{
    private sealed record Ping(string? Payload = null) : Event;

    private sealed record Pong(string Note) : Event;

    [Fact]
    public async Task PublishAsync_DeliversToInstanceHandler()
    {
        var bus = new InMemoryEventBus();
        var received = new List<string>();
        bus.Subscribe<Ping>(new RecordingHandler(received));

        await bus.PublishAsync(new Ping("hello"));

        Assert.Equal(["hello"], received);
    }

    [Fact]
    public async Task PublishAsync_DeliversToLambdaSubscriber()
    {
        var bus = new InMemoryEventBus();
        string? payload = null;
        bus.Subscribe<Ping>((e, _) =>
        {
            payload = e.Payload;
            return Task.CompletedTask;
        });

        await bus.PublishAsync(new Ping("hi"));

        Assert.Equal("hi", payload);
    }

    [Fact]
    public async Task PublishAsync_FanOut_AllSubscribersReceiveEveryEvent()
    {
        var bus = new InMemoryEventBus();
        var a = new List<string>();
        var b = new List<string>();
        bus.Subscribe<Ping>(new RecordingHandler(a));
        bus.Subscribe<Ping>(new RecordingHandler(b));

        await bus.PublishAsync(new Ping("1"));
        await bus.PublishAsync(new Ping("2"));

        Assert.Equal(["1", "2"], a);
        Assert.Equal(["1", "2"], b);
    }

    [Fact]
    public async Task Subscribe_DisposeToken_StopsDelivery()
    {
        var bus = new InMemoryEventBus();
        var received = new List<string>();
        var token = bus.Subscribe<Ping>(new RecordingHandler(received));

        await bus.PublishAsync(new Ping("before"));
        token.Dispose();
        await bus.PublishAsync(new Ping("after"));

        Assert.Equal(["before"], received);
    }

    [Fact]
    public async Task Subscribe_DisposeTwice_IsIdempotent()
    {
        var bus = new InMemoryEventBus();
        var received = new List<string>();
        var token = bus.Subscribe<Ping>(new RecordingHandler(received));

        token.Dispose();
        token.Dispose();
        await bus.PublishAsync(new Ping("x"));

        Assert.Empty(received);
    }

    [Fact]
    public async Task PublishAsync_HandlerThrows_OtherHandlersStillRun_ThenAggregateThrown()
    {
        var bus = new InMemoryEventBus();
        var healthy = 0;
        bus.Subscribe<Ping>((_, _) =>
        {
            healthy++;
            return Task.CompletedTask;
        });
        bus.Subscribe<Ping>((_, _) => throw new InvalidOperationException("boom"));

        // 单个订阅者失败 → WhenAll 解包为原始异常（Task.WhenAll 惯用行为）
        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => bus.PublishAsync(new Ping()));

        Assert.Equal(1, healthy);   // 异常被隔离，健康订阅者照常执行
        Assert.Equal("boom", ex.Message);
    }

    [Fact]
    public async Task PublishAsync_HandlerThrows_WithErrorSink_SwallowedAndForwarded()
    {
        var forwarded = new List<(Exception Exception, IEvent Event)>();
        var bus = new InMemoryEventBus(new EventBusOptions
        {
            OnHandlerError = (ex, e) =>
            {
                forwarded.Add((ex, e));
                return Task.CompletedTask;
            },
        });
        bus.Subscribe<Ping>((_, _) => throw new InvalidOperationException("boom"));

        await bus.PublishAsync(new Ping("corr") { CorrelationId = "run-1" });   // 不抛

        var (exception, @event) = Assert.Single(forwarded);
        Assert.Equal("boom", exception.Message);
        Assert.Equal("run-1", ((Event)@event).CorrelationId);
    }

    [Fact]
    public async Task SubscribeTyped_ResolvesHandlerFromServiceProvider()
    {
        var services = new ServiceCollection();
        services.AddSingleton<RecordingHandler>();
        var provider = services.BuildServiceProvider();
        var bus = new InMemoryEventBus(serviceProvider: provider);

        bus.Subscribe<Ping, RecordingHandler>();
        await bus.PublishAsync(new Ping("from-di"));

        var handler = provider.GetRequiredService<RecordingHandler>();
        Assert.Equal(["from-di"], handler.Events);
    }

    [Fact]
    public async Task SubscribeTyped_WithoutProvider_FallsBackToActivator()
    {
        var bus = new InMemoryEventBus();   // 无 IServiceProvider
        bus.Subscribe<Ping, CounterHandler>();

        await bus.PublishAsync(new Ping());

        Assert.Equal(1, CounterHandler.Count);
    }

    [Fact]
    public async Task CreateConsumer_ReceivesPublishedEventsInOrder()
    {
        var bus = new InMemoryEventBus();
        using var consumer = bus.CreateConsumer<Ping>();
        await bus.PublishAsync(new Ping("a"));
        await bus.PublishAsync(new Ping("b"));
        await bus.PublishAsync(new Ping("c"));

        var received = new List<string>();
        await foreach (var e in consumer.ConsumeAsync())
        {
            received.Add(e.Payload!);
            if (received.Count == 3)
                break;
        }

        Assert.Equal(["a", "b", "c"], received);
    }

    [Fact]
    public async Task CreateConsumer_Dispose_StopsReceiving()
    {
        var bus = new InMemoryEventBus();
        var consumer = bus.CreateConsumer<Ping>();
        await bus.PublishAsync(new Ping("a"));
        Assert.Equal("a", (await ReadNext(consumer)).Payload);

        consumer.Dispose();
        await bus.PublishAsync(new Ping("b"));

        var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
        var count = 0;
        await foreach (var _ in consumer.ConsumeAsync(cts.Token))
            count++;
        Assert.Equal(0, count);   // 通道已 complete，无残留事件
    }

    [Fact]
    public async Task CreateConsumer_IsFanOutToAllConsumers()
    {
        var bus = new InMemoryEventBus();
        using var c1 = bus.CreateConsumer<Ping>();
        using var c2 = bus.CreateConsumer<Ping>();

        await bus.PublishAsync(new Ping("x"));

        Assert.Equal("x", (await ReadNext(c1)).Payload);
        Assert.Equal("x", (await ReadNext(c2)).Payload);
    }

    [Fact]
    public async Task CreateConsumer_DoesNotReceiveOtherEventTypes()
    {
        var bus = new InMemoryEventBus();
        using var consumer = bus.CreateConsumer<Ping>();
        await bus.PublishAsync(new Pong("not-a-ping"));
        await bus.PublishAsync(new Ping("actual"));

        var received = new List<string>();
        await foreach (var e in consumer.ConsumeAsync())
        {
            received.Add(e.Payload!);
            if (received.Count == 1)
                break;
        }

        Assert.Equal(["actual"], received);   // Pong 永远不会进入 Ping 消费者
    }

    [Fact]
    public async Task PublishAsync_ConcurrentPublishers_AllSubscribersSeeAllEvents()
    {
        var bus = new InMemoryEventBus();
        var received = new ConcurrentBag<int>();
        bus.Subscribe<Ping>((e, _) =>
        {
            received.Add(int.Parse(e.Payload!));
            return Task.CompletedTask;
        });

        var publishes = Enumerable.Range(0, 100)
            .Select(i => bus.PublishAsync(new Ping(i.ToString())));
        await Task.WhenAll(publishes);

        Assert.Equal(100, received.Count);
    }

    [Fact]
    public void EventBase_PopulatesIdCreatedAtAndCorrelationId()
    {
        var e = new Ping("x") { CorrelationId = "run-1" };

        Assert.NotEqual(Guid.Empty, e.Id);
        Assert.True(e.CreatedAt > DateTimeOffset.UnixEpoch);
        Assert.Equal("run-1", e.CorrelationId);
    }

    [Fact]
    public void AddEventBus_RegistersSingletonBus()
    {
        var services = new ServiceCollection();
        services.AddEventBus(o => o.OnHandlerError = (_, _) => Task.CompletedTask);
        using var provider = services.BuildServiceProvider();

        var bus = provider.GetRequiredService<IEventBus>();

        Assert.IsType<InMemoryEventBus>(bus);
        Assert.Same(bus, provider.GetRequiredService<IEventBus>());
    }

    private static async Task<Ping> ReadNext(IEventConsumer<Ping> consumer)
    {
        await foreach (var e in consumer.ConsumeAsync())
            return e;
        throw new InvalidOperationException("没有可消费的事件。");
    }

    /// <summary>把收到的事件记录到外部列表的处理器（含无参构造，供 DI/Activator 使用）。</summary>
    private sealed class RecordingHandler : IEventHandler<Ping>
    {
        private readonly List<string>? _sink;

        public RecordingHandler() => _sink = null;

        public RecordingHandler(List<string> sink) => _sink = sink;

        public List<string> Events { get; } = [];

        public Task HandleAsync(Ping @event, CancellationToken cancellationToken = default)
        {
            Events.Add(@event.Payload!);
            _sink?.Add(@event.Payload!);
            return Task.CompletedTask;
        }
    }

    /// <summary>带静态计数器的处理器，验证无 DI 时走 Activator 无参构造。</summary>
    private sealed class CounterHandler : IEventHandler<Ping>
    {
        public static int Count;

        public Task HandleAsync(Ping @event, CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref Count);
            return Task.CompletedTask;
        }
    }
}
