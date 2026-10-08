namespace Core.Providers.DeepSeek;

/// <summary>
/// DeepSeek 适配器插件的配置（对应 DSH 的 adapter Config）。
///
/// 注意：这里的字段<b>故意</b>不进入共享契约 —— 它们是 DeepSeek 特有的开关，
/// 放在适配器自己的配置段里（DSH 文档：#35 "提供方特有的思考模式开关仍放在适配器的 Config 中"）。
/// </summary>
public sealed class DeepSeekAdapterConfig
{
    /// <summary>API Key。缺省读环境变量 <see cref="DeepSeekDefaults.ApiKeyEnvironmentVariable"/>。</summary>
    public string? ApiKey { get; set; }

    /// <summary>端点。默认 <see cref="DeepSeekDefaults.Endpoint"/>；strict 模式需要 <see cref="DeepSeekDefaults.BetaEndpoint"/>。</summary>
    public string? BaseUrl { get; set; }

    /// <summary>
    /// 默认推理强度（一个不透明 ID，值域见 <see cref="DeepSeekReasoning"/>）。
    /// 缺省为 null = 用 DeepSeek 自己的默认（开启思考，effort=high）。
    /// </summary>
    public string? DefaultReasoningEffort { get; set; }

    /// <summary>是否启用严格工具模式（需要 beta 端点）。</summary>
    public bool StrictTools { get; set; }

    /// <summary>单次请求超时（秒）。默认 <see cref="DeepSeekDefaults.RequestTimeoutSeconds"/>。</summary>
    public double TimeoutSeconds { get; set; } = DeepSeekDefaults.RequestTimeoutSeconds;
}