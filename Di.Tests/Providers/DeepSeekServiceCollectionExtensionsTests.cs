using System.Net.Http;
using Core.Providers.DeepSeek;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http;

namespace Di.Tests.Providers;

/// <summary>
/// 针对 <see cref="DeepSeekServiceCollectionExtensions"/> 的 DI 装配测试：
/// HttpClient 不再设总时长超时（<see cref="HttpClient.Timeout"/> 覆盖整个流式正文读取，
/// 60s 硬卡会把长响应掐断）——响应头等待与流式空闲超时由适配器自行控制
/// （<see cref="DeepSeekDefaults.RequestTimeoutSeconds"/> / <see cref="DeepSeekDefaults.StreamIdleTimeoutSeconds"/>）。
/// 且主处理器默认绕过系统代理（<see cref="DeepSeekAdapterConfig.UseSystemProxy"/> = false，
/// 避免 Windows 上 IE/WinINET 代理（常指向 Clash 等本地代理）把 api 请求二次转发拖慢首 token）。
/// </summary>
public sealed class DeepSeekServiceCollectionExtensionsTests
{
    [Fact]
    public void AddDeepSeek_HttpClient_HasNoTotalTimeout()
    {
        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().Build());
        services.AddDeepSeek();

        using var provider = services.BuildServiceProvider();
        using var client = provider.GetRequiredService<IHttpClientFactory>()
            .CreateClient(DeepSeekDefaults.ProviderId);

        Assert.Equal(Timeout.InfiniteTimeSpan, client.Timeout);
    }

    [Fact]
    public void AddDeepSeek_HttpHandler_BypassesSystemProxy_ByDefault()
    {
        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().Build());
        services.AddDeepSeek();

        using var provider = services.BuildServiceProvider();
        using var handler = provider.GetRequiredService<IHttpMessageHandlerFactory>()
            .CreateHandler(DeepSeekDefaults.ProviderId);

        var sockets = FindSocketsHttpHandler(handler);
        Assert.NotNull(sockets);
        Assert.False(sockets.UseProxy, "默认应绕过系统代理（UseSystemProxy=false）");
    }

    [Fact]
    public void AddDeepSeek_UseSystemProxyTrue_KeepsSystemProxy()
    {
        var services = new ServiceCollection();
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["DeepSeek:UseSystemProxy"] = "true" })
            .Build();
        services.AddSingleton<IConfiguration>(config);
        services.AddDeepSeek();

        using var provider = services.BuildServiceProvider();
        using var handler = provider.GetRequiredService<IHttpMessageHandlerFactory>()
            .CreateHandler(DeepSeekDefaults.ProviderId);

        var sockets = FindSocketsHttpHandler(handler);
        Assert.NotNull(sockets);
        Assert.True(sockets.UseProxy, "UseSystemProxy=true 时应保留系统代理");
    }

    /// <summary>沿处理链穿透委派包装，取到底层 <see cref="SocketsHttpHandler"/>（无则 null）。</summary>
    private static SocketsHttpHandler? FindSocketsHttpHandler(HttpMessageHandler handler)
    {
        var current = handler;
        while (current is not SocketsHttpHandler)
        {
            current = (current as DelegatingHandler)?.InnerHandler;
            if (current is null)
                return null;
        }
        return (SocketsHttpHandler)current;
    }
}
