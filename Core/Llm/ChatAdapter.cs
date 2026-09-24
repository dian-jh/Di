namespace Core.Llm;

/// <summary>
/// 提供方线格式适配器（对应 DSH 的 LlmAdapter）。
///
/// <b>只有 <see cref="StreamAsync"/> 是抽象的</b>，其余全是有默认实现的虚方法。
/// 适配器通过 <see cref="ILlmService.RegisterAdapter"/> 注册到宿主。
/// </summary>
public abstract class ChatAdapter
{
    /// <summary>
    /// 该适配器自声明的 provider 路由（如 "deepseek"）。DI 装配时（AddLlm）据此
    /// 把适配器装入 LlmRuntime 路由表；未列出的路由仍可经 <see cref="ILlmService.RegisterAdapter"/> 动态注册。
    /// </summary>
    public virtual IReadOnlyList<string> ProviderIds => [];

    /// <summary>一个 provider 路由的展示元数据。</summary>
    public virtual LlmProviderInfo ProviderInfo(string provider) => new(provider, provider);

    /// <summary>
    /// 模型目录（咨询性）：适配器可以接受的模型列表，用于 UI/选择器。
    /// <b>未列出的模型 ID 适配器仍可能接受</b>；消费方不得把"不在列表"当成请求拒绝理由。
    /// </summary>
    public virtual Task<IReadOnlyList<LlmModelInfo>> ListModelsAsync(string provider, CancellationToken cancellationToken = default)
        => Task.FromResult<IReadOnlyList<LlmModelInfo>>([]);

    /// <summary>
    /// 精确模型元数据（独立于咨询性目录）：context / defaultMaxTokens / 推理强度列表。
    /// </summary>
    public virtual Task<LlmResolvedModelInfo> ResolveModelAsync(string provider, string model, CancellationToken cancellationToken = default)
        => Task.FromResult(new LlmResolvedModelInfo(provider, model, model));

    /// <summary>
    /// 把模型元数据与最终的 stream 绑定到同一"代"。
    /// 动态适配器（配置可热重载的）必须覆盖它，防止"一代的能力 + 另一代的端点"错配。
    /// </summary>
    public virtual async Task<PreparedAdapterCall> PrepareCallAsync(string provider, string model, CancellationToken cancellationToken = default)
    {
        var resolved = await ResolveModelAsync(provider, model, cancellationToken).ConfigureAwait(false);
        return new PreparedAdapterCall(resolved, StreamAsync);
    }

    /// <summary>
    /// ★ 唯一抽象成员。流式调用，遵守 <see cref="StreamChunk"/> 的协议义务。
    /// 传输/协议故障从这里抛出（<see cref="LlmException"/>）；提供方带内故障以 Finish(Error/Aborted) 结束流。
    /// </summary>
    public abstract IAsyncEnumerable<StreamChunk> StreamAsync(GenerateOptions options, CancellationToken cancellationToken);
}
