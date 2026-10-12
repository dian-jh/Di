using Core.Providers.DeepSeek;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Di.Tests.Providers;

/// <summary>
/// 针对 <see cref="DeepSeekServiceCollectionExtensions"/> 的 DI 装配测试：
/// HttpClient 不再设总时长超时（<see cref="HttpClient.Timeout"/> 覆盖整个流式正文读取，
/// 60s 硬卡会把长响应掐断）——响应头等待与流式空闲超时由适配器自行控制
/// （<see cref="DeepSeekDefaults.RequestTimeoutSeconds"/> / <see cref="DeepSeekDefaults.StreamIdleTimeoutSeconds"/>）。
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
}
