using Core.Llm;
using Core.Providers.DeepSeek;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Di.Tests.Providers;

/// <summary>
/// DeepSeek 鉴权延迟解析（P0-①）：配置段（DeepSeek:ApiKey）优先于环境变量；
/// DI 装配不再要求已配置密钥（缺省由请求路径抛 MissingCredential，宿主可正常启动）。
/// </summary>
public sealed class DeepSeekAuthTests
{
    [Fact]
    public async Task ResolveApiKeyAsync_ConfigKey_PrecedesEnv()
    {
        var adapter = new DeepSeekAdapter(
            new HttpClient(), new DeepSeekAdapterConfig { ApiKey = "from-config" });

        var key = await adapter.ResolveApiKeyAsync("deepseek", new FakeStore { Key = "from-env" });

        Assert.Equal("from-config", key);   // 配置段优先，不碰环境变量
    }

    [Fact]
    public async Task ResolveApiKeyAsync_NoConfigKey_FallsBackToStore()
    {
        var adapter = new DeepSeekAdapter(
            new HttpClient(), new DeepSeekAdapterConfig { ApiKey = null });

        var key = await adapter.ResolveApiKeyAsync("deepseek", new FakeStore { Key = "from-env" });

        Assert.Equal("from-env", key);
    }

    [Fact]
    public async Task ResolveApiKeyAsync_NothingConfigured_ReturnsNull()
    {
        var adapter = new DeepSeekAdapter(
            new HttpClient(), new DeepSeekAdapterConfig { ApiKey = null });

        var key = await adapter.ResolveApiKeyAsync("deepseek", new FakeStore { Key = null });

        Assert.Null(key);   // 宿主据此抛 MISSING_CREDENTIAL，而非启动崩溃
    }

    [Fact]
    public void AddDeepSeek_AssemblyDoesNotRequireApiKey()
    {
        // 无任何密钥配置，DI 装配也必须成功（密钥在请求时才解析）。
        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().Build());
        services.AddLlm();
        services.AddDeepSeek();

        using var provider = services.BuildServiceProvider();
        var llm = provider.GetRequiredService<ILlmService>();

        Assert.NotNull(llm);
    }

    private sealed class FakeStore : ILlmCredentialStore
    {
        public string? Key { get; set; }

        public Task<string?> ResolveApiKeyAsync(
            string provider, IReadOnlyList<string> environmentVariables, CancellationToken cancellationToken = default)
            => Task.FromResult(Key);
    }
}
