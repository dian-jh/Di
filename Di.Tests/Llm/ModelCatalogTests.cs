using System.Runtime.CompilerServices;
using Core.Llm;

namespace Di.Tests.Llm;

/// <summary>
/// 模型目录数据化（P0-②）：适配器声明 <see cref="ChatAdapter.Catalog"/>（纯数据），
/// 基类据此派生咨询性列表与精确元数据；<see cref="LlmRuntime"/> 提供跨 provider 的统一目录门面。
/// 目录是咨询性的——未列入的模型 ID 仍可请求（不拒绝），坏适配器不连锁崩溃（尽力而为）。
/// </summary>
public sealed class ModelCatalogTests
{
    private static readonly ModelSpec Alpha = new(
        Id: "alpha", Name: "Alpha Model",
        ContextWindow: 128_000, DefaultMaxTokens: 8_192,
        ReasoningEfforts: [new ReasoningEffort("low", "Low"), new ReasoningEffort("high", "High")],
        Cost: new ModelCostRates(1.0, 2.0, CacheReadPerMillion: 0.2));

    private static readonly ModelSpec Beta = new(Id: "beta", Name: "Beta Model");

    // ---- ChatAdapter 基类派生 ----

    [Fact]
    public void ListModels_DerivesFromCatalog()
    {
        var adapter = new CatalogAdapter("test", [Alpha, Beta]);

        var models = adapter.ListModels("test");

        Assert.Equal(2, models.Count);
        Assert.Equal("alpha", models[0].Id);
        Assert.Equal("Alpha Model", models[0].Name);
        Assert.Equal("test", models[0].Provider);
    }

    [Fact]
    public void ResolveModelAsync_KnownModel_ReturnsCatalogMetadata()
    {
        var adapter = new CatalogAdapter("test", [Alpha, Beta]);

        var resolved = adapter.ResolveModelAsync("test", "alpha").Result;

        Assert.Equal(128_000, resolved.Context!.ContextWindow);
        Assert.Equal(8_192, resolved.DefaultMaxTokens);
        Assert.Equal(2, resolved.Reasoning!.Efforts.Count);
    }

    [Fact]
    public void ResolveModelAsync_UnknownModel_ReturnsDefaultsWithoutThrowing()
    {
        // 目录是咨询性：未列入的模型仍可请求，元数据未知时给默认值，绝不拒绝。
        var adapter = new CatalogAdapter("test", [Alpha]);

        var resolved = adapter.ResolveModelAsync("test", "ghost-model").Result;

        Assert.Equal("ghost-model", resolved.Id);
        Assert.Null(resolved.Context);
        Assert.Null(resolved.Reasoning);
    }

    // ---- LlmRuntime 统一目录门面 ----

    [Fact]
    public void RegisterAdapter_Conflict_DoesNotLeavePartialRoutes()
    {
        var runtime = new LlmRuntime();
        runtime.RegisterAdapter(["occupied"], new CatalogAdapter("occupied", [Alpha]));
        Assert.Throws<LlmException>(() => runtime.RegisterAdapter(
            ["new", "occupied"], new CatalogAdapter("new", [Beta])));
        Assert.Empty(runtime.ListModels("new"));
    }

    [Fact]
    public void Replace_AnotherRegistrationOfSameAdapter_CannotTakeOwnership()
    {
        var runtime = new LlmRuntime();
        var adapter = new CatalogAdapter("test", [Alpha]);
        using var first = runtime.RegisterAdapter(["first"], adapter);
        using var second = runtime.RegisterAdapter(["second"], adapter);
        Assert.Throws<LlmException>(() => first.Replace(["first", "second"]));
        first.Dispose();
        Assert.Single(runtime.ListModels("second"));
    }

    [Fact]
    public void Registration_CallerMutatesArrays_DisposeStillRemovesOwnedRoutes()
    {
        var runtime = new LlmRuntime();
        string[] providers = ["initial"];
        var handle = runtime.RegisterAdapter(providers, new CatalogAdapter("test", [Alpha]));
        providers[0] = "mutated";
        handle.Dispose();
        Assert.Empty(runtime.ListProviders());

        handle = runtime.RegisterAdapter(["initial"], new CatalogAdapter("test", [Alpha]));
        providers = ["replacement"];
        handle.Replace(providers);
        providers[0] = "mutated";
        handle.Dispose();
        Assert.Empty(runtime.ListProviders());
    }

    [Fact]
    public async Task Replace_ConcurrentDispose_NeverLeavesRoutesBehind()
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            var runtime = new LlmRuntime();
            var handle = runtime.RegisterAdapter(["initial"], new CatalogAdapter("test", [Alpha]));
            await Task.WhenAll(Task.Run(() =>
            {
                try { handle.Replace(["replacement"]); }
                catch (ObjectDisposedException) { }
            }), Task.Run(handle.Dispose));
            Assert.Empty(runtime.ListProviders());
        }
    }

    [Fact]
    public void ListModels_AggregatesAcrossAdapters()
    {
        var runtime = new LlmRuntime();
        runtime.RegisterAdapter(["pa"], new CatalogAdapter("pa", [Alpha]));
        runtime.RegisterAdapter(["pb"], new CatalogAdapter("pb", [Beta]));

        var models = runtime.ListModels();

        Assert.Equal(2, models.Count);
        Assert.Contains(models, m => m.Provider == "pa" && m.Id == "alpha");
        Assert.Contains(models, m => m.Provider == "pb" && m.Id == "beta");
    }

    [Fact]
    public void ListModels_ProviderFilter_OnlyReturnsThatProvider()
    {
        var runtime = new LlmRuntime();
        runtime.RegisterAdapter(["pa"], new CatalogAdapter("pa", [Alpha, Beta]));
        runtime.RegisterAdapter(["pb"], new CatalogAdapter("pb", [Alpha]));

        var models = runtime.ListModels("pb");

        Assert.Single(models);
        Assert.Equal("pb", models[0].Provider);
    }

    [Fact]
    public void ListModels_ThrowingAdapter_IsBestEffort()
    {
        // 坏适配器不连锁崩溃：抛异常的适配器只贡献零模型。
        var runtime = new LlmRuntime();
        runtime.RegisterAdapter(["pa"], new CatalogAdapter("pa", [Alpha], throwOnList: true));
        runtime.RegisterAdapter(["pb"], new CatalogAdapter("pb", [Beta]));

        var models = runtime.ListModels();

        var model = Assert.Single(models);
        Assert.Equal("beta", model.Id);
    }

    // ---- LlmRuntime 成本查询 ----

    [Fact]
    public void CalculateCost_KnownModel_ComputesFromCatalogRates()
    {
        var runtime = new LlmRuntime();
        runtime.RegisterAdapter(["test"], new CatalogAdapter("test", [Alpha]));

        var usage = new TokenUsage(1_000_000, 1_000_000, CacheReadTokens: 1_000_000);
        var cost = runtime.CalculateCost("test", "alpha", usage);

        Assert.NotNull(cost);
        Assert.Equal(1.0, cost!.Input, precision: 6);
        Assert.Equal(2.0, cost.Output, precision: 6);
        Assert.Equal(0.2, cost.CacheRead, precision: 6);
        Assert.Equal(3.2, cost.Total, precision: 6);
    }

    [Fact]
    public void CalculateCost_UnknownProvider_ReturnsNull()
    {
        var runtime = new LlmRuntime();
        runtime.RegisterAdapter(["test"], new CatalogAdapter("test", [Alpha]));

        Assert.Null(runtime.CalculateCost("ghost", "alpha", TokenUsage.Zero));
    }

    [Fact]
    public void CalculateCost_ModelWithoutRates_ReturnsNull()
    {
        var runtime = new LlmRuntime();
        runtime.RegisterAdapter(["test"], new CatalogAdapter("test", [Beta]));   // Beta 无 Cost 费率

        Assert.Null(runtime.CalculateCost("test", "beta", TokenUsage.Zero));
    }

    private sealed class CatalogAdapter : ChatAdapter
    {
        private readonly string _provider;
        private readonly bool _throwOnList;

        public CatalogAdapter(string provider, IReadOnlyList<ModelSpec> catalog, bool throwOnList = false)
        {
            _provider = provider;
            _throwOnList = throwOnList;
            Catalog = catalog;
        }

        public override IReadOnlyList<string> ProviderIds => [_provider];

        public override IReadOnlyList<ModelSpec> Catalog { get; }

        public override IReadOnlyList<LlmModelInfo> ListModels(string provider)
        {
            if (_throwOnList)
                throw new InvalidOperationException("bad adapter");
            return base.ListModels(provider);
        }

        public override IAsyncEnumerable<StreamChunk> StreamAsync(
            GenerateOptions options, [EnumeratorCancellation] CancellationToken cancellationToken)
            => throw new NotSupportedException();
    }
}
