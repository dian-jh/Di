using System.Runtime.CompilerServices;
using Core.Llm;

namespace Di.Tests.Llm;

/// <summary>
/// 鉴权抽象与延迟解析（P0-①）：适配器声明自己的鉴权方式（<see cref="ChatAdapter.Auth"/>），
/// <see cref="LlmRuntime"/> 在<b>请求时</b>经 <see cref="ILlmCredentialStore"/> 解析 API Key。
/// 缺失凭据 → 请求时抛 <see cref="LlmErrorCodes.MissingCredential"/>，宿主可正常启动再提示配置
/// （不再像之前那样在 DI 装配/启动阶段直接崩掉）。
/// </summary>
public sealed class AuthTests
{
    private static GenerateOptions Options() => new()
    {
        Provider = "p",
        Model = "m",
        Messages = [ChatMessage.User("hi")],
    };

    // ---- LlmRuntime.CheckAuthAsync ----

    [Fact]
    public async Task CheckAuthAsync_ApiKeyResolvable_ReturnsTrue()
    {
        var runtime = new LlmRuntime(new FakeCredentialStore { Key = "secret" });
        runtime.RegisterAdapter(["p"], new AuthAdapter("p", LlmAuthDefinition.EnvApiKey("key", ["K"])));

        Assert.True(await runtime.CheckAuthAsync("p"));
    }

    [Fact]
    public async Task CheckAuthAsync_ApiKeyMissing_ReturnsFalse()
    {
        var runtime = new LlmRuntime(new FakeCredentialStore { Key = null });
        runtime.RegisterAdapter(["p"], new AuthAdapter("p", LlmAuthDefinition.EnvApiKey("key", ["K"])));

        Assert.False(await runtime.CheckAuthAsync("p"));
    }

    [Fact]
    public async Task CheckAuthAsync_UnknownProvider_ReturnsFalse()
    {
        var runtime = new LlmRuntime(new FakeCredentialStore());

        Assert.False(await runtime.CheckAuthAsync("ghost"));
    }

    [Fact]
    public async Task CheckAuthAsync_KeylessAdapter_ReturnsTrue()
    {
        // 无鉴权要求的适配器（如本地模型）恒为已配置。
        var runtime = new LlmRuntime(new FakeCredentialStore());
        runtime.RegisterAdapter(["p"], new AuthAdapter("p", LlmAuthDefinition.None));

        Assert.True(await runtime.CheckAuthAsync("p"));
    }

    // ---- LlmRuntime.StreamAsync 请求时鉴权 ----

    [Fact]
    public async Task StreamAsync_MissingApiKey_ThrowsMissingCredential()
    {
        var runtime = new LlmRuntime(new FakeCredentialStore { Key = null });
        var adapter = new AuthAdapter("p", LlmAuthDefinition.EnvApiKey("key", ["K"]));
        runtime.RegisterAdapter(["p"], adapter);

        var ex = await Assert.ThrowsAsync<LlmException>(async () =>
        {
            await foreach (var _ in runtime.StreamAsync(Options())) { }
        });

        Assert.Equal(LlmErrorCodes.MissingCredential, ex.Code);
        Assert.Null(adapter.LastOptions);   // 凭据缺失时适配器不被调用
    }

    [Fact]
    public async Task StreamAsync_WithApiKey_ResolvesAndPassesToAdapter()
    {
        var store = new FakeCredentialStore { Key = "secret" };
        var runtime = new LlmRuntime(store);
        var adapter = new AuthAdapter("p", LlmAuthDefinition.EnvApiKey("DeepSeek API key", ["DS_KEY"]));
        runtime.RegisterAdapter(["p"], adapter);

        var chunks = new List<StreamChunk>();
        await foreach (var chunk in runtime.StreamAsync(Options()))
            chunks.Add(chunk);

        Assert.Equal("secret", adapter.LastOptions!.ApiKey);
        Assert.Equal(["DS_KEY"], store.EnvVars.Single());   // 声明里列出的环境变量被依次尝试
        Assert.Contains(chunks, c => c is StreamChunk.Finish);
    }

    [Fact]
    public async Task StreamAsync_KeylessAdapter_DoesNotRequireApiKey()
    {
        var runtime = new LlmRuntime(new FakeCredentialStore());
        var adapter = new AuthAdapter("p", LlmAuthDefinition.None);
        runtime.RegisterAdapter(["p"], adapter);

        var chunks = new List<StreamChunk>();
        await foreach (var chunk in runtime.StreamAsync(Options()))
            chunks.Add(chunk);

        Assert.Null(adapter.LastOptions!.ApiKey);
        Assert.Contains(chunks, c => c is StreamChunk.Finish);
    }

    // ---- 环境变量凭证存储 ----

    [Fact]
    public async Task EnvironmentCredentialStore_ReadsFirstNonEmptyEnvVar()
    {
        const string varA = "DI_TEST_AUTH_A_928374";
        const string varB = "DI_TEST_AUTH_B_928374";
        Environment.SetEnvironmentVariable(varA, "value-a");
        Environment.SetEnvironmentVariable(varB, "value-b");
        try
        {
            var store = new EnvironmentCredentialStore();

            var resolved = await store.ResolveApiKeyAsync("p", [varA, varB]);

            Assert.Equal("value-a", resolved);   // 命中第一个即可
        }
        finally
        {
            Environment.SetEnvironmentVariable(varA, null);
            Environment.SetEnvironmentVariable(varB, null);
        }
    }

    [Fact]
    public async Task EnvironmentCredentialStore_AllUnset_ReturnsNull()
    {
        const string varA = "DI_TEST_AUTH_MISSING_928374";
        var store = new EnvironmentCredentialStore();

        var resolved = await store.ResolveApiKeyAsync("p", [varA]);

        Assert.Null(resolved);
    }

    private sealed class FakeCredentialStore : ILlmCredentialStore
    {
        public string? Key { get; set; }
        public List<string[]> EnvVars { get; } = [];

        public Task<string?> ResolveApiKeyAsync(
            string provider, IReadOnlyList<string> environmentVariables, CancellationToken cancellationToken = default)
        {
            EnvVars.Add([.. environmentVariables]);
            return Task.FromResult(Key);
        }
    }

    private sealed class AuthAdapter : ChatAdapter
    {
        private readonly string _provider;

        public AuthAdapter(string provider, LlmAuthDefinition auth)
        {
            _provider = provider;
            Auth = auth;
        }

        public override IReadOnlyList<string> ProviderIds => [_provider];

        public override LlmAuthDefinition Auth { get; }

        public GenerateOptions? LastOptions { get; private set; }

        public override async IAsyncEnumerable<StreamChunk> StreamAsync(
            GenerateOptions options, [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            LastOptions = options;
            await Task.CompletedTask;
            yield return new StreamChunk.Finish(new FinishReason.Stop());
        }
    }
}
