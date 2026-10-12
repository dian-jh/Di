namespace Core.Llm;

/// <summary>
/// 提供方线格式适配器（对应 DSH 的 LlmAdapter）。
///
/// <b>只有 <see cref="StreamAsync"/> 是抽象的</b>，其余全是有默认实现的虚方法。
/// 适配器通过 <see cref="ILlmService.RegisterAdapter"/> 注册到宿主。
/// 设计文档见 docs/modules/llm.md。
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
    /// 该适配器的鉴权声明。宿主在<b>请求时</b>据此解析凭据；缺失时以
    /// <see cref="LlmErrorCodes.MissingCredential"/> 拒绝，而不是启动即崩。
    /// </summary>
    public virtual LlmAuthDefinition Auth => LlmAuthDefinition.None;

    /// <summary>
    /// 解析一次请求用的 API Key（请求时、惰性）。基类实现按 <see cref="Auth"/> 声明
    /// 让 <see cref="ILlmCredentialStore"/> 依次尝试环境变量；适配器可覆盖以叠加
    /// 自己的配置来源（如 appsettings 的 DeepSeek:ApiKey 优先于环境变量）。
    /// 返回 null = 未配置（宿主负责抛 MissingCredential）。
    /// </summary>
    public virtual Task<string?> ResolveApiKeyAsync(
        string provider,
        ILlmCredentialStore store,
        CancellationToken cancellationToken = default)
        => Auth switch
        {
            LlmAuthDefinition.ApiKey apiKey => store.ResolveApiKeyAsync(provider, apiKey.EnvironmentVariables, cancellationToken),
            _ => Task.FromResult<string?>(null),
        };

    /// <summary>
    /// 模型目录（纯数据，咨询性）：适配器认识的模型及其元数据（上下文 / 默认 maxTokens /
    /// 推理强度 / 成本费率），供选择器与计量使用。基类的 <see cref="ListModels"/> 与
    /// <see cref="ResolveModelAsync"/> 都从这里派生。
    /// <b>未列入目录的模型 ID 适配器仍可能接受</b>；消费方不得把"不在目录"当成请求拒绝理由。
    /// </summary>
    public virtual IReadOnlyList<ModelSpec> Catalog => [];

    /// <summary>
    /// 模型列表（咨询性、同步、尽力而为）。基类实现从 <see cref="Catalog"/> 派生。
    /// 覆盖者必须保持"永不抛"的约定（宿主对坏适配器按空列表处理）。
    /// </summary>
    public virtual IReadOnlyList<LlmModelInfo> ListModels(string provider)
        => Catalog.Select(m => new LlmModelInfo(provider, m.Id, m.Name)).ToList();

    /// <summary>
    /// 精确模型元数据（独立于咨询性目录）：context / defaultMaxTokens / 推理强度列表。
    /// 基类实现从 <see cref="Catalog"/> 派生；未列入目录的模型返回默认值（Id/Name），不拒绝。
    /// </summary>
    public virtual Task<LlmResolvedModelInfo> ResolveModelAsync(string provider, string model, CancellationToken cancellationToken = default)
    {
        var spec = Catalog.FirstOrDefault(m => m.Id == model);
        return Task.FromResult(new LlmResolvedModelInfo(
            provider,
            model,
            spec?.Name ?? model,
            Context: spec?.ContextWindow is { } contextWindow ? new LlmModelContext(contextWindow) : null,
            DefaultMaxTokens: spec?.DefaultMaxTokens,
            Reasoning: spec?.ReasoningEfforts is { Count: > 0 } efforts
                ? new LlmModelReasoningInfo(efforts)
                : null));
    }

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
