using Core.Providers.DeepSeek;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Di.Tests.Providers;

/// <summary>
/// 针对 <see cref="DeepSeekServiceCollectionExtensions"/> 的 DI 装配测试：
/// 命名 HttpClient 应带上显式请求超时（默认 <see cref="DeepSeekDefaults.RequestTimeoutSeconds"/> 秒），
/// 避免网络挂起时界面长时间无反馈。
/// </summary>
public sealed class DeepSeekServiceCollectionExtensionsTests
{
    [Fact]
    public void AddDeepSeek_HttpClient_HasExplicitRequestTimeout()
    {
        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().Build());
        services.AddDeepSeek();

        using var provider = services.BuildServiceProvider();
        using var client = provider.GetRequiredService<IHttpClientFactory>()
            .CreateClient(DeepSeekDefaults.ProviderId);

        Assert.Equal(TimeSpan.FromSeconds(DeepSeekDefaults.RequestTimeoutSeconds), client.Timeout);
    }
}
