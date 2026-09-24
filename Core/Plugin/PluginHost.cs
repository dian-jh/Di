namespace Core.Plugin;

/// <summary>
/// 插件宿主。对应 Cordis 的运行时：负责安装插件、解析依赖顺序、管理服务作用域。
///
/// 生命周期：
/// <code>
/// using var host = new PluginHost();
/// host.Install(new SettingsPlugin(), new LlmPlugin(), new DeepSeekAdapterPlugin(), …);
/// await host.InitializeAsync(ct);      // 拓扑排序 + 逐个 Apply + 依赖点火
/// … 使用 …
/// host.Dispose();                      // 逆序撤销所有插件作用域
/// </code>
/// </summary>
public sealed class PluginHost : IPluginContext, IDisposable
{
    private readonly Dictionary<string, object?> _services = new(StringComparer.Ordinal);
    private readonly Dictionary<string, IDisposable> _serviceDisposables = new(StringComparer.Ordinal);
    private readonly List<IPlugin> _plugins = [];
    private readonly List<PendingInjection> _pendingInjections = [];
    private readonly CancellationTokenSource _shutdown = new();

    private readonly List<(string Name, Stack<IDisposable> Disposables)> _scopes = [];
    private Stack<IDisposable> _currentScope = null!;
    private bool _initialized;

    public IReadOnlyCollection<string> Services => _services.Keys;

    public CancellationToken Shutdown => _shutdown.Token;

    public PluginHost(IReadOnlyList<IPlugin>? plugins = null)
    {
        if (plugins is not null)
            foreach (var plugin in plugins)
                Install(plugin);
    }

    /// <summary>登记一个插件实例（不立即执行，等 <see cref="InitializeAsync"/>）。</summary>
    public PluginHost Install(IPlugin plugin)
    {
        ArgumentNullException.ThrowIfNull(plugin);
        if (_initialized)
            throw new InvalidOperationException("宿主已初始化，不能再安装插件。");

        _plugins.Add(plugin);
        return this;
    }

    /// <summary>
    /// 按依赖顺序初始化所有插件。
    /// 顺序规则：先安装的插件先 Apply（声明顺序即优先级），
    /// 依赖未就绪的插件通过 <see cref="IPluginContext.Inject"/> 延迟点火，
    /// 因此不会因为声明的先后而错乱。
    /// </summary>
    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        if (_initialized)
            return;

        _initialized = true;
        _currentScope = new Stack<IDisposable>();

        // 逐个 Apply：副作用注册阶段（同步）。
        foreach (var plugin in _plugins)
        {
            _scopes.Add((plugin.Name, _currentScope));
            plugin.Apply(this);
        }

        // 注入回调已就绪的先跑；尚未就绪的等它依赖的服务注册。
        FlushReadyInjections();

        // 异步初始化阶段（可选 IStartup）。
        foreach (var plugin in _plugins)
        {
            if (plugin is IStartup startup)
                await startup.StartAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    public T? Get<T>() where T : class
    {
        var key = ServiceKey<T>();
        if (_services.TryGetValue(key, out var value))
            return value as T;

        // 登记依赖：该服务之后注册时会触发 Inject 回调。
        RegisterDependency(key);
        return null;
    }

    public IDisposable Provide<T>(T service) where T : class
    {
        var key = ServiceKey<T>();
        ArgumentNullException.ThrowIfNull(service);

        if (_services.ContainsKey(key))
            throw new InvalidOperationException($"服务 '{key}' 已被注册，拒绝静默覆盖。");

        _services[key] = service;

        // 服务本身可释放？交给作用域统一管理（插件卸载时撤销）。
        var scope = _currentScope;
        var handle = new ScopeDisposable(() =>
        {
            if (_services.Remove(key) && service is IDisposable d)
                d.Dispose();
        });

        // 放进当前作用域，以便卸载时一起释放。
        scope.Push(handle);

        // 依赖该服务的注入可能被阻塞，现在解锁。
        FlushReadyInjections();
        return handle;
    }

    public void Inject(IReadOnlyList<string> services, Action<IPluginContext> callback)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(callback);

        if (services.Count == 0)
        {
            callback(this);
            return;
        }

        _pendingInjections.Add(new PendingInjection(services, callback));
        FlushReadyInjections();
    }

    public void Dispose()
    {
        // 逆序撤销：后安装的插件先卸载（对应 DSH 的依赖卸载顺序）。
        for (var i = _scopes.Count - 1; i >= 0; i--)
        {
            var (name, disposables) = _scopes[i];
            while (disposables.Count > 0)
            {
                try
                {
                    disposables.Pop().Dispose();
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"[PluginHost] 撤销插件 '{name}' 时出错: {ex.Message}");
                }
            }
        }

        _scopes.Clear();
        _shutdown.Cancel();
        _shutdown.Dispose();
    }

    // ---- 内部实现 ----

    private static string ServiceKey<T>() => typeof(T).Name;

    private void RegisterDependency(string key)
    {
        // 依赖未就绪的注入回调登记在 _pendingInjections，当 Provide 注册时再检查。
        // 这里无需额外动作——Get 时登记，Provide 时 FlushReadyInjections 会触发。
    }

    private void FlushReadyInjections()
    {
        var ready = _pendingInjections
            .Where(p => p.Services.All(_services.ContainsKey))
            .ToList();

        if (ready.Count == 0)
            return;

        // 逐个移除并执行；执行期间可能产生新的 pending，所以用循环直到稳定。
        var executed = true;
        while (executed)
        {
            executed = false;
            var snapshot = _pendingInjections.ToList();
            foreach (var pending in snapshot)
            {
                if (!pending.Services.All(_services.ContainsKey))
                    continue;

                _pendingInjections.Remove(pending);
                pending.Callback(this);
                executed = true;
                break;   // 回调可能修改 _pendingInjections，重启扫描
            }
        }
    }

    private sealed record PendingInjection(IReadOnlyList<string> Services, Action<IPluginContext> Callback);

    private sealed class ScopeDisposable(Action onDispose) : IDisposable
    {
        private Action? _onDispose = onDispose;

        public void Dispose()
        {
            Interlocked.Exchange(ref _onDispose, null)?.Invoke();
        }
    }
}
