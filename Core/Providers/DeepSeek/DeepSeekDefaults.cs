using System.Text.Json;
using System.Text.Json.Serialization;

namespace Core.Providers.DeepSeek;

/// <summary>
/// DeepSeek API 常量。官方文档：https://api-docs.deepseek.com/zh-cn/api/create-chat-completion
/// </summary>
public static class DeepSeekDefaults
{
    public const string Endpoint = "https://api.deepseek.com";
    public const string BetaEndpoint = "https://api.deepseek.com/beta";
    public const string ChatCompletionsPath = "/chat/completions";

    public const string ProviderId = "deepseek";
    public const string ApiKeyEnvironmentVariable = "DEEPSEEK_API_KEY";

    /// <summary>响应头等待超时（秒）。默认 60 —— 服务器迟迟不开始响应时快速以 <see cref="LlmErrorCodes.Timeout"/> 失败，而不是让用户无限等待。</summary>
    public const int RequestTimeoutSeconds = 60;

    /// <summary>流式响应空闲超时（秒）。默认 60 —— 连续两个 SSE 数据帧之间超过该时长视为流挂起，
    /// 以 <see cref="LlmErrorCodes.Timeout"/> 抛<b>可重试</b>异常。注意与总时长超时不同：
    /// 长思考/长输出不设总时长上限，只盯"多久没来数据"（HttpClient.Timeout 覆盖整个正文读取，不能当流式超时用）。</summary>
    public const double StreamIdleTimeoutSeconds = 60;

    public const int MaxTokensLimit = 393_216;
    public const int StopLimit = 16;

    public static class Roles
    {
        public const string System = "system";
        public const string User = "user";
        public const string Assistant = "assistant";
        public const string Tool = "tool";
    }

    public static class ThinkingTypes
    {
        public const string Enabled = "enabled";
        public const string Disabled = "disabled";
    }

    public static class ReasoningEfforts
    {
        public const string None = "none";
        public const string Low = "low";
        public const string High = "high";
        public const string Max = "max";
    }

    public static class ToolTypes
    {
        public const string Function = "function";
    }

    public static class ToolChoices
    {
        public const string None = "none";
        public const string Auto = "auto";
        public const string Required = "required";
    }

    public static class ResponseFormats
    {
        public const string Text = "text";
        public const string JsonObject = "json_object";
    }
}

/// <summary>DeepSeek 线格式的 JSON 配置。</summary>
internal static class DeepSeekJson
{
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}
