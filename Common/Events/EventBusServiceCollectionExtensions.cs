using Microsoft.Extensions.DependencyInjection;

namespace Common.Events;

/// <summary>事件总线的 DI 注册扩展。</summary>
public static class EventBusServiceCollectionExtensions
{
    /// <summary>
    /// 注册单例 <see cref="IEventBus"/>（内存实现）。
    /// 传入 <paramref name="configure"/> 可配置错误接收器等；总线内建 <see cref="IServiceProvider"/>，
    /// 因此 <see cref="IEventBus.Subscribe{TEvent,THandler}"/> 能解析容器中注册的处理器。
    /// </summary>
    public static IServiceCollection AddEventBus(this IServiceCollection services, Action<EventBusOptions>? configure = null)
    {
        ArgumentNullException.ThrowIfNull(services);

        var options = new EventBusOptions();
        configure?.Invoke(options);

        services.AddSingleton<IEventBus>(sp => new InMemoryEventBus(options, sp));
        return services;
    }
}
