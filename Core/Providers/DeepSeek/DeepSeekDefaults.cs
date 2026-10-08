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

    /// <summary>单次请求超时（秒）。默认 60 —— 网络挂起时快速以 <see cref="LlmErrorCodes.Timeout"/> 失败，而不是让用户无限等待。</summary>
    public const int RequestTimeoutSeconds = 60;

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
