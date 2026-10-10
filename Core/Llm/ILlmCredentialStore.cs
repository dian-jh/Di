namespace Core.Llm;

/// <summary>
/// 凭证存储（可注入替换，默认 <see cref="EnvironmentCredentialStore"/>）。
/// 鉴权解析是<b>请求时</b>的，不在组合根——宿主无密钥也能正常启动，UI 显示"未配置"，
/// 而不是直接崩掉（对应 Pi：门面 getAuth / checkAuth；缺失 → 请求时错误）。
/// 解析规则：适配器声明的环境变量依次尝试，第一个非空命中即返回。
/// </summary>
public interface ILlmCredentialStore
{
    Task<string?> ResolveApiKeyAsync(
        string provider,
        IReadOnlyList<string> environmentVariables,
        CancellationToken cancellationToken = default);
}

/// <summary>默认实现：从环境变量解析 API Key。</summary>
public sealed class EnvironmentCredentialStore : ILlmCredentialStore
{
    public Task<string?> ResolveApiKeyAsync(
        string provider,
        IReadOnlyList<string> environmentVariables,
        CancellationToken cancellationToken = default)
    {
        var key = environmentVariables
            .Select(Environment.GetEnvironmentVariable)
            .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
        return Task.FromResult(key);
    }
}
