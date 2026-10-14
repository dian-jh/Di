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

    /// <summary>
    /// 是否走 Windows 系统代理（IE/WinINET 注册表配置）。默认 false：绕过系统代理直连。
    /// .NET HttpClient 默认 <c>UseProxy=true</c> 会读系统代理（本机常被 FlClash 等指向
    /// 127.0.0.1:10005），把 api.deepseek.com 请求二次转发，光响应头就慢 1.5-3.8s
    /// （2026-10-14 实测根因；pi/Bun 只读 env 代理天然直连）。确有代理需求的部署设 true。
    /// </summary>
    public bool UseSystemProxy { get; set; }

    /// <summary>响应头等待超时（秒）。默认 <see cref="DeepSeekDefaults.RequestTimeoutSeconds"/>。</summary>
    public double TimeoutSeconds { get; set; } = DeepSeekDefaults.RequestTimeoutSeconds;

    /// <summary>流式响应空闲超时（秒）。默认 <see cref="DeepSeekDefaults.StreamIdleTimeoutSeconds"/>。
    /// 连续两帧之间超过该时长视为流挂起，抛可重试 Timeout。</summary>
    public double StreamIdleTimeoutSeconds { get; set; } = DeepSeekDefaults.StreamIdleTimeoutSeconds;
}