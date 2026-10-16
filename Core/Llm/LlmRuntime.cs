using System.Collections.Immutable;

namespace Core.Llm;

/// <summary>
/// 模型层服务实现（对应 DSH 的 LlmRuntime）。
/// 职责：适配器注册/路由 / 请求分发 / provider 拓扑通知。
/// </summary>
public sealed class LlmRuntime : ILlmService
{
    // provider 路由 → (adapter, registration)。同一路由只允许一个适配器。
    private volatile ImmutableDictionary<string, (ChatAdapter Adapter, AdapterRegistrationHandle Handle)> _routes =
        ImmutableDictionary.Create<string, (ChatAdapter, AdapterRegistrationHandle)>(StringComparer.Ordinal);
    private readonly object _routeLock = new();

    private readonly ILlmCredentialStore _credentials;

    public LlmRuntime(ILlmCredentialStore? credentials = null)
    {
        _credentials = credentials ?? new EnvironmentCredentialStore();
    }

    public event Action? AdaptersUpdated;

    public IAdapterRegistration RegisterAdapter(string[] providers, ChatAdapter adapter)
    {
        ArgumentNullException.ThrowIfNull(providers);
        ArgumentNullException.ThrowIfNull(adapter);
        providers = (string[])providers.Clone();

        if (providers.Length == 0 || providers.Any(string.IsNullOrWhiteSpace))
            throw new LlmException("至少需要一个非空 provider 路由。", LlmErrorCodes.InvalidAdapter);

        if (providers.Distinct(StringComparer.Ordinal).Count() != providers.Length)
            throw new LlmException($"路由重复：{string.Join(", ", providers)}。", LlmErrorCodes.InvalidAdapter);

        AdapterRegistrationHandle handle;
        lock (_routeLock)
        {
            foreach (var provider in providers)
            {
                if (_routes.ContainsKey(provider))
                    throw new LlmException($"provider '{provider}' 已被其它适配器注册。", LlmErrorCodes.InvalidAdapter);
            }
            handle = new AdapterRegistrationHandle(this, providers, adapter);
            _routes = _routes.AddRange(providers.Select(provider =>
                new KeyValuePair<string, (ChatAdapter, AdapterRegistrationHandle)>(provider, (adapter, handle))));
        }

        AdaptersUpdated?.Invoke();
        return handle;
    }

    public IReadOnlyList<LlmProviderInfo> ListProviders() =>
        _routes.Select(kv => kv.Value.Adapter.ProviderInfo(kv.Key)).ToList();

    public Task<IReadOnlyList<LlmModelInfo>> RefreshModelsAsync(string provider, CancellationToken cancellationToken = default)
        => RequireAdapter(provider).RefreshModelsAsync(provider, cancellationToken);

    public IReadOnlyList<LlmModelInfo> ListModels(string? provider = null)
    {
        if (provider is not null)
            return _routes.TryGetValue(provider, out var entry) ? SafeListModels(entry.Adapter, provider) : [];

        var models = new List<LlmModelInfo>();
        foreach (var (id, (adapter, _)) in _routes)
            models.AddRange(SafeListModels(adapter, id));
        return models;
    }

    /// <summary>尽力而为：坏适配器只贡献零模型，绝不连锁抛异常（Pi：getModels 同步且永不抛）。</summary>
    private static IReadOnlyList<LlmModelInfo> SafeListModels(ChatAdapter adapter, string provider)
    {
        try
        {
            return adapter.ListModels(provider);
        }
        catch
        {
            return [];
        }
    }

    public UsageCost? CalculateCost(string provider, string model, TokenUsage usage)
    {
        if (!_routes.TryGetValue(provider, out var entry))
            return null;
        var rates = entry.Adapter.Catalog.FirstOrDefault(m => m.Id == model)?.Cost;
        return rates is null ? null : CostCalculator.Calculate(rates, usage);
    }

    public async Task<LlmResolvedModelInfo> ResolveModelAsync(string provider, string model, CancellationToken cancellationToken = default)
    {
        var adapter = RequireAdapter(provider);
        return await adapter.ResolveModelAsync(provider, model, cancellationToken).ConfigureAwait(false);
    }

    public async IAsyncEnumerable<StreamChunk> StreamAsync(GenerateOptions options)
    {
        var adapter = RequireAdapter(options.Provider);

        // 请求时鉴权解析：声明了 ApiKey 鉴权但解析不到 → MISSING_CREDENTIAL，不静默放行。
        // （Pi：applyAuth 在请求路径解析；缺失 → 请求级错误，宿主正常启动后 UI 提示"未配置"。）
        var apiKey = await adapter.ResolveApiKeyAsync(options.Provider, _credentials, options.CancellationToken)
            .ConfigureAwait(false);
        if (adapter.Auth is LlmAuthDefinition.ApiKey or LlmAuthDefinition.OAuth && string.IsNullOrWhiteSpace(apiKey))
            throw new LlmException(
                adapter.Auth is LlmAuthDefinition.OAuth oauth
                    ? $"provider '{options.Provider}' 尚未授权（{oauth.DisplayName}）。"
                    : $"provider '{options.Provider}' 未配置 API Key（请设置环境变量或配置段后重试）。",
                LlmErrorCodes.MissingCredential);

        var prepared = await adapter.PrepareCallAsync(options.Provider, options.Model, options.CancellationToken)
            .ConfigureAwait(false);

        // 校验请求的推理强度是否为该模型支持（不支持的抛 UNSUPPORTED_OPTION，不静默降级）。
        if (options.ReasoningEffort is not null &&
            prepared.Model.Reasoning is { } reasoning &&
            reasoning.Efforts.All(e => e.Id != options.ReasoningEffort))
        {
            var supported = string.Join(", ", reasoning.Efforts.Select(e => e.Id));
            throw new LlmException(
                $"模型 '{options.Model}' 不支持推理强度 '{options.ReasoningEffort}'（支持：{supported}）。",
                LlmErrorCodes.UnsupportedOption);
        }

        var callOptions = options with { ApiKey = apiKey };
        await foreach (var chunk in prepared.Stream(callOptions, options.CancellationToken).ConfigureAwait(false))
            yield return chunk;
    }

    public async Task<bool> CheckAuthAsync(string provider, CancellationToken cancellationToken = default)
    {
        if (!_routes.TryGetValue(provider, out var entry))
            return false;
        return await entry.Adapter.CheckAuthAsync(provider, _credentials, cancellationToken).ConfigureAwait(false);
    }

    private ChatAdapter RequireAdapter(string provider)
    {
        if (_routes.TryGetValue(provider, out var entry))
            return entry.Adapter;

        throw new LlmException(
            $"未注册的 provider '{provider}'（已注册：{string.Join(", ", _routes.Keys)}）。",
            LlmErrorCodes.InvalidAdapter);
    }

    /// <summary>注册句柄实现：dispose 撤销全部路由；Replace 原子替换。</summary>
    private sealed class AdapterRegistrationHandle : IAdapterRegistration
    {
        private readonly LlmRuntime _owner;
        private readonly ChatAdapter _adapter;
        private string[] _providers;
        private bool _disposed;

        public AdapterRegistrationHandle(LlmRuntime owner, string[] providers, ChatAdapter adapter)
        {
            _owner = owner;
            _adapter = adapter;
            _providers = providers;
        }

        public void Replace(string[] providers)
        {
            ArgumentNullException.ThrowIfNull(providers);
            providers = (string[])providers.Clone();

            // 先校验候选集：冲突/非法必须抛，且保持当前路由不变。
            if (providers.Any(string.IsNullOrWhiteSpace))
                throw new LlmException("路由不能为空。", LlmErrorCodes.InvalidAdapter);

            lock (_owner._routeLock)
            {
                ObjectDisposedException.ThrowIf(_disposed, this);
                foreach (var provider in providers)
                {
                    if (_owner._routes.TryGetValue(provider, out var existing) &&
                        !ReferenceEquals(existing.Handle, this))
                        throw new LlmException($"provider '{provider}' 已被其它适配器注册。", LlmErrorCodes.InvalidAdapter);
                }
                var routes = _owner._routes.RemoveRange(_providers);
                foreach (var provider in providers)
                    routes = routes.SetItem(provider, (_adapter, this));
                _owner._routes = routes;
                _providers = providers;
            }
            _owner.AdaptersUpdated?.Invoke();
        }

        public void Dispose()
        {
            lock (_owner._routeLock)
            {
                if (_disposed)
                    return;
                _disposed = true;
                _owner._routes = _owner._routes.RemoveRange(_providers);
            }

            _owner.AdaptersUpdated?.Invoke();
        }
    }
}
