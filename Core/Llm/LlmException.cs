namespace Core.Llm;

/// <summary>
/// 模型调用异常（传输与协议故障路径）。
/// 带稳定 code（如 MISSING_CREDENTIAL / UNSUPPORTED_OPTION / INVALID_REQUEST / TIMEOUT / RATE_LIMITED）。
/// 带内故障（提供方返回错误）不抛异常，而是以 Finish(Error) 结束流。
/// </summary>
public sealed class LlmException : Exception
{
    public LlmException(string message, string code, int? status = null, TimeSpan? providerRetryAfter = null, Exception? inner = null)
        : base(message, inner)
    {
        Code = code;
        Status = status;
        ProviderRetryAfter = providerRetryAfter;
    }

    /// <summary>稳定的机器可读错误码。</summary>
    public string Code { get; }

    public int? Status { get; }

    /// <summary>提供方要求的等待时间（来自 Retry-After 头）。</summary>
    public TimeSpan? ProviderRetryAfter { get; }

    /// <summary>是否值得重试：限流 / 超时 / 连接故障 / 服务端错误。凭据类故障不重试。</summary>
    public bool IsRetryable =>
        Status is 408 or 429 or >= 500
        || Code is LlmErrorCodes.Timeout or LlmErrorCodes.Connection or LlmErrorCodes.RateLimited;

    public override string ToString() => $"[{Code}] {Message} (status={Status?.ToString() ?? "n/a"})";
}

/// <summary>常量错误码。</summary>
public static class LlmErrorCodes
{
    public const string MissingCredential = "MISSING_CREDENTIAL";
    public const string UnsupportedOption = "UNSUPPORTED_OPTION";
    public const string InvalidRequest = "INVALID_REQUEST";
    public const string RateLimited = "RATE_LIMITED";
    public const string Timeout = "TIMEOUT";
    public const string Connection = "CONNECTION";
    public const string BadResponse = "BAD_RESPONSE";
    public const string InvalidAdapter = "INVALID_ADAPTER";
}
