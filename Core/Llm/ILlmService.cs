namespace Core.Llm;

/// <summary>
/// 模型层服务（对应 DSH 的 LlmRuntime）。插件通过 <see cref="IPluginContext.Get{T}"/> 取它。
/// 适配器插件在这里注册；上层在这里发起请求。
/// </summary>
public interface ILlmService
{
    /// <summary>
    /// 注册一个适配器及其拥有的 provider 路由。
    /// 返回的 handle 是可释放的，释放时撤销全部路由；<c>Replace</c> 原子替换路由集合，
    /// 不留"路由消失"的观察窗口（对应 DSH 的 AdapterRegistrationHandle）。
    /// </summary>
    IAdapterRegistration RegisterAdapter(string[] providers, ChatAdapter adapter);

    /// <summary>当前所有 provider 路由的展示元数据。</summary>
    IReadOnlyList<LlmProviderInfo> ListProviders();

    /// <summary>精确模型元数据（咨询性目录之外的真实解析）。</summary>
    Task<LlmResolvedModelInfo> ResolveModelAsync(string provider, string model, CancellationToken cancellationToken = default);

    /// <summary>发起一次模型调用。未注册的 provider 抛 <see cref="LlmErrorCodes.InvalidAdapter"/>。</summary>
    IAsyncEnumerable<StreamChunk> StreamAsync(GenerateOptions options);

    /// <summary>provider 拓扑变化（适配器注册/注销/替换）时触发。消费方重新读取状态。</summary>
    event Action AdaptersUpdated;
}

/// <summary>适配器注册句柄：disposer + 原子路由替换。</summary>
public interface IAdapterRegistration : IDisposable
{
    /// <summary>
    /// 原子替换本注册持有的路由集合，保持同一个适配器实例。
    /// 空数组合法（一个配置段被清空时持有零路由但保持注册）。
    /// 已被释放的注册调用 Replace 抛 <see cref="ObjectDisposedException"/>。
    /// </summary>
    void Replace(string[] providers);
}
