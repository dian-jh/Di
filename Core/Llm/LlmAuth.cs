namespace Core.Llm;

/// <summary>
/// 适配器声明的鉴权方式（对应 Pi 的 <c>auth</c>：apiKey / oauth）。
/// 鉴权从请求逻辑中剥离——所有协议共享同一套凭证解析，各家不重复实现。
/// 声明是"数据"（怎么解析），实际解析由 <see cref="ILlmCredentialStore"/> 在请求时完成。
/// </summary>
public abstract record LlmAuthDefinition
{
    public sealed record OAuth(string DisplayName) : LlmAuthDefinition;
    /// <summary>无鉴权要求（本地模型 / 无密钥服务）。</summary>
    public static LlmAuthDefinition None { get; } = new NoneDefinition();

    private sealed record NoneDefinition : LlmAuthDefinition;

    /// <summary>API Key 鉴权：解析规则 = 已存凭证/配置 &gt; 依次命中的环境变量（见 <see cref="ILlmCredentialStore"/>）。</summary>
    public sealed record ApiKey(string DisplayName, IReadOnlyList<string> EnvironmentVariables) : LlmAuthDefinition;

    /// <summary>便捷工厂：声明一个从环境变量读的 API Key 鉴权。</summary>
    public static ApiKey EnvApiKey(string displayName, params string[] environmentVariables) => new(displayName, environmentVariables);
}
