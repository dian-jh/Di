using System.Text.Json;
using System.Text.Json.Nodes;
using Core.Llm;

namespace Core.Providers.DeepSeek;

/// <summary>
/// DeepSeek ↔ <c>Core.Llm</c> 双向翻译。所有 DeepSeek 特有的"怪癖"唯一允许存在的地方。
///
/// <list type="number">
/// <item>携带 tools 时历史 reasoning_content 必须完整回传，否则 400。</item>
/// <item>思考模式下 tool_choice=required / 指定函数会 400（抛 UNSUPPORTED_OPTION）。</item>
/// <item>思考模式下 reasoning_effort 不应与 type=disabled 同时出现。</item>
/// <item>未设置的集合不能序列化成 []（破坏服务端前缀缓存）。</item>
/// <item>strict 模式需要 beta 域名。</item>
/// <item>不支持的推理强度/参数抛 UNSUPPORTED_OPTION，不静默降级。</item>
/// </list>
/// </summary>
internal static class DeepSeekTranslator
{
    public static DeepSeekChatRequest ToWire(GenerateOptions options)
    {
        var hasTools = options.Tools is { Count: > 0 };

        var wire = new DeepSeekChatRequest
        {
            Model = options.Model,
            Messages = [.. options.Messages.Select(m => ToWireMessage(m, hasTools))],
            Stream = true,
            StreamOptions = new DeepSeekStreamOptions { IncludeUsage = true },
            Thinking = BuildThinking(options),
            MaxTokens = options.MaxTokens,
            Temperature = options.Temperature,
            UserId = options.UserId,
            Stop = options.Stop is { Count: > 0 } stop ? [.. stop] : null,
            Tools = hasTools ? [.. options.Tools!.Select(ToWireTool)] : null,
            ToolChoice = hasTools ? ToWireToolChoice(options.ToolChoice, options) : null,
        };

        ValidateDeepSeekSpecific(wire, options);
        return wire;
    }

    private static DeepSeekMessage ToWireMessage(ChatMessage message, bool hasTools)
    {
        var wire = new DeepSeekMessage
        {
            Role = message.Role switch
            {
                ChatRole.System => DeepSeekDefaults.Roles.System,
                ChatRole.User => DeepSeekDefaults.Roles.User,
                ChatRole.Assistant => DeepSeekDefaults.Roles.Assistant,
                ChatRole.Tool => DeepSeekDefaults.Roles.Tool,
                _ => throw new LlmException($"未知角色 {message.Role}。", LlmErrorCodes.InvalidRequest),
            },
        };

        switch (message)
        {
            case SystemMessage system:
                wire.Content = system.Text;
                break;

            case UserMessage user:
                wire.Content = ToWireContent(user);
                break;

            case AssistantMessage assistant:
                wire.Content = string.IsNullOrEmpty(assistant.GetText()) ? null : assistant.GetText();
                wire.ReasoningContent = assistant.Reasoning;
                if (assistant.ToolCalls.Count > 0)
                {
                    wire.ToolCalls =
                    [
                        .. assistant.ToolCalls.Select(call => new DeepSeekToolCall
                        {
                            Id = call.Id,
                            Type = DeepSeekDefaults.ToolTypes.Function,
                            Function = new DeepSeekFunctionCall { Name = call.Name, Arguments = call.Arguments },
                        }),
                    ];
                }
                // 规则 1：带 tools 时历史 reasoning 必须回传（即使为空字符串也要占位？
                // 官方要求"完整回传"，缺字段会 400；这里保留实际值即可）
                break;

            case ToolResultMessage tool:
                wire.Content = tool.Content;
                wire.ToolCallId = tool.ToolCallId;
                break;
        }

        return wire;
    }

    private static object? ToWireContent(UserMessage user)
    {
        if (user.Content.Count == 0)
            return null;

        // 纯文本走 string 形态（与官方样例一致，也最省 token）。
        if (user.Content.All(c => c is TextBlock))
            return user.GetText();

        var parts = new List<DeepSeekContentPart>();
        foreach (var block in user.Content)
        {
            switch (block)
            {
                case TextBlock text:
                    parts.Add(new DeepSeekContentPart { Type = "text", Text = text.Text });
                    break;
                case ImageBlock image:
                    parts.Add(new DeepSeekContentPart
                    {
                        Type = "image_url",
                        ImageUrl = new DeepSeekImageUrl { Url = image.AttachmentId, Detail = image.Detail },
                    });
                    break;
                default:
                    throw new LlmException(
                        $"DeepSeek 不支持 user 消息中的块类型 '{block.Type}'。",
                        LlmErrorCodes.UnsupportedOption);
            }
        }

        return parts;
    }

    private static DeepSeekTool ToWireTool(ChatTool tool)
    {
        if (tool.Name.Length > 128)
            throw new LlmException($"工具名 '{tool.Name}' 超过 128 字符。", LlmErrorCodes.InvalidRequest);

        return new DeepSeekTool
        {
            Type = DeepSeekDefaults.ToolTypes.Function,
            Function = new DeepSeekFunction
            {
                Name = tool.Name,
                Description = tool.Description,
                Parameters = tool.Parameters,
                Strict = tool.Strict,
            },
        };
    }

    private static DeepSeekToolChoice? ToWireToolChoice(ChatToolChoice choice, GenerateOptions options) => choice switch
    {
        ChatToolChoice.Auto => DeepSeekToolChoice.Auto,
        ChatToolChoice.None => DeepSeekToolChoice.None,
        ChatToolChoice.Required => DeepSeekToolChoice.Required,
        ChatToolChoice.Function function => DeepSeekToolChoice.Function(function.Name),
        _ => throw new LlmException($"未知的 ToolChoice {choice.GetType().Name}。", LlmErrorCodes.InvalidRequest),
    };

    private static DeepSeekThinking? BuildThinking(GenerateOptions options)
    {
        // 推理强度映射（适配器拥有的不透明 ID → 协议值）。
        // 注意：minimal/medium/xhigh/ultra 的兼容映射是 DeepSeek 内部细节，不对外暴露。
        var effort = options.ReasoningEffort switch
        {
            null or "default" => null,
            "off" or "none" => DeepSeekDefaults.ReasoningEfforts.None,
            "low" => DeepSeekDefaults.ReasoningEfforts.Low,
            "high" => DeepSeekDefaults.ReasoningEfforts.High,
            "max" => DeepSeekDefaults.ReasoningEfforts.Max,
            var unknown => throw new LlmException(
                $"DeepSeek 不支持推理强度 '{unknown}'（支持：off/low/high/max）。",
                LlmErrorCodes.UnsupportedOption),
        };

        if (effort is null)
            return null; // 默认：DeepSeek 默认开启思考，effort=high

        if (effort == DeepSeekDefaults.ReasoningEfforts.None)
            return new DeepSeekThinking { Type = DeepSeekDefaults.ThinkingTypes.Disabled };

        return new DeepSeekThinking
        {
            Type = DeepSeekDefaults.ThinkingTypes.Enabled,
            ReasoningEffort = effort,
        };
    }

    private static void ValidateDeepSeekSpecific(DeepSeekChatRequest wire, GenerateOptions options)
    {
        var thinkingDisabled =
            wire.Thinking?.Type == DeepSeekDefaults.ThinkingTypes.Disabled ||
            wire.Thinking?.ReasoningEffort == DeepSeekDefaults.ReasoningEfforts.None;

        // 规则 2：思考模式下不支持 required / 指定具体函数。
        if (!thinkingDisabled &&
            options.Tools is { Count: > 0 } &&
            options.ToolChoice is ChatToolChoice.Required or ChatToolChoice.Function)
        {
            throw new LlmException(
                "DeepSeek 在思考模式下不支持 tool_choice=required 或指定具体函数，请改用 auto 或先关闭思考模式。",
                LlmErrorCodes.UnsupportedOption);
        }

        if (options.Stop is { Count: > DeepSeekDefaults.StopLimit })
            throw new LlmException($"Stop 最多 {DeepSeekDefaults.StopLimit} 个序列。", LlmErrorCodes.InvalidRequest);

        if (options.MaxTokens is > DeepSeekDefaults.MaxTokensLimit)
            throw new LlmException($"MaxTokens 超过上限 {DeepSeekDefaults.MaxTokensLimit}。", LlmErrorCodes.InvalidRequest);
    }

    // ---- 从线格式翻译回 Core.Llm ----

    /// <summary>把非流式响应翻译成 AssistantMessage。</summary>
    public static AssistantMessage FromResponse(DeepSeekChatResponse response)
    {
        var choice = response.Choices?.FirstOrDefault();
        if (choice?.Message is not { } message)
            throw new LlmException("DeepSeek 响应缺少 choices[0].message。", LlmErrorCodes.BadResponse);

        var content = new List<IContentBlock>();
        if (!string.IsNullOrEmpty(message.ReasoningContent))
            content.Add(new ReasoningBlock(message.ReasoningContent));
        if (!string.IsNullOrEmpty(message.Content))
            content.Add(new TextBlock(message.Content));
        if (message.ToolCalls is { Count: > 0 })
        {
            foreach (var call in message.ToolCalls)
            {
                content.Add(new ToolCallBlock(
                    call.Id ?? string.Empty,
                    call.Function?.Name ?? string.Empty,
                    call.Function?.Arguments ?? "{}"));
            }
        }

        return new AssistantMessage(content);
    }

    public static FinishReason FromFinishReason(string? finishReason) => finishReason switch
    {
        "stop" => new FinishReason.Stop(),
        "tool_calls" => new FinishReason.ToolCalls(),
        "length" => new FinishReason.MaxTokens(),
        "insufficient_system_resource" => new FinishReason.Error(new LlmFailure(
            "系统推理资源不足，生成被打断。", "INSUFFICIENT_SYSTEM_RESOURCE", Status: 503)),
        "content_filter" => new FinishReason.Error(new LlmFailure(
            "输出内容因触发过滤策略而被过滤。", "CONTENT_FILTERED")),
        "aborted" => new FinishReason.Aborted(new LlmFailure("生成过程被中断。", "ABORTED")),
        _ => new FinishReason.Error(new LlmFailure($"未知 finish_reason: '{finishReason}'。", "UNKNOWN_FINISH_REASON")),
    };

    public static TokenUsage ToUsage(DeepSeekUsage usage) => new(
        InputTokens: usage.PromptTokens,
        OutputTokens: usage.CompletionTokens,
        TotalTokens: usage.TotalTokens,
        CacheReadTokens: usage.PromptTokensDetails?.PromptCacheHitTokens ?? usage.PromptTokensDetails?.CachedTokens,
        ReasoningTokens: usage.CompletionTokensDetails?.ReasoningTokens);
}

internal sealed class DeepSeekContentPart
{
    public required string Type { get; set; }
    public string? Text { get; set; }
    public DeepSeekImageUrl? ImageUrl { get; set; }
}

internal sealed class DeepSeekImageUrl
{
    public required string Url { get; set; }
    public string? Detail { get; set; }
}
