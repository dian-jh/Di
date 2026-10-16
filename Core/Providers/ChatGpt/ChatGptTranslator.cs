using System.Text.Json.Nodes;
using Core.Llm;

namespace Core.Providers.ChatGpt;

internal static class ChatGptTranslator
{
    public static JsonObject Request(GenerateOptions options)
    {
        if (options.Temperature is not null || options.TopP is not null || options.FrequencyPenalty is not null ||
            options.PresencePenalty is not null || options.MaxTokens is not null || options.Stop is { Count: > 0 })
            throw new LlmException("ChatGPT plan Responses does not support sampling, penalties, max tokens or stop options.", LlmErrorCodes.UnsupportedOption);
        var input = new JsonArray();
        foreach (var message in options.Messages)
        {
            switch (message)
            {
                case SystemMessage system:
                    input.Add(new JsonObject { ["role"] = "developer", ["content"] = system.Text });
                    break;
                case UserMessage user:
                    var content = new JsonArray();
                    foreach (var block in user.Content)
                        content.Add(block switch
                        {
                            TextBlock text => new JsonObject { ["type"] = "input_text", ["text"] = text.Text },
                            ImageBlock image when IsImageUrl(image.AttachmentId) => new JsonObject
                            { ["type"] = "input_image", ["image_url"] = image.AttachmentId, ["detail"] = image.Detail ?? "auto" },
                            FileBlock file when file.AttachmentId.StartsWith("data:", StringComparison.Ordinal) => new JsonObject
                            { ["type"] = "input_file", ["file_data"] = file.AttachmentId, ["filename"] = file.Filename ?? "attachment" },
                            _ => throw new LlmException("Unsupported or unresolved ChatGPT attachment/content block: " + block.Type, LlmErrorCodes.UnsupportedOption)
                        });
                    input.Add(new JsonObject { ["role"] = "user", ["content"] = content });
                    break;
                case AssistantMessage assistant:
                    // Encrypted reasoning must precede calls when replaying stateless responses.
                    foreach (var opaque in assistant.Content.OfType<OpaqueBlock>())
                    {
                        if (opaque.UnknownType != "chatgpt.reasoning")
                            throw new LlmException("Unsupported opaque ChatGPT block.", LlmErrorCodes.UnsupportedOption);
                        input.Add(JsonNode.Parse(opaque.RawJson));
                    }
                    foreach (var block in assistant.Content)
                    {
                        switch (block)
                        {
                            case TextBlock text:
                                input.Add(new JsonObject { ["role"] = "assistant", ["content"] = new JsonArray(
                                    new JsonObject { ["type"] = "output_text", ["text"] = text.Text }) });
                                break;
                            case ToolCallBlock call:
                                input.Add(new JsonObject { ["type"] = "function_call", ["call_id"] = call.Id,
                                    ["name"] = call.Name, ["namespace"] = "di", ["arguments"] = call.Arguments });
                                break;
                            case ReasoningBlock or OpaqueBlock: break; // summaries are display-only; encrypted item is replayed above
                            default: throw new LlmException("Unsupported assistant block: " + block.Type, LlmErrorCodes.UnsupportedOption);
                        }
                    }
                    break;
                case ToolResultMessage result:
                    input.Add(new JsonObject { ["type"] = "function_call_output", ["call_id"] = result.ToolCallId, ["output"] = result.Content });
                    break;
                default: throw new LlmException("Unsupported ChatGPT message.", LlmErrorCodes.UnsupportedOption);
            }
        }
        var request = new JsonObject
        {
            ["model"] = options.Model, ["input"] = input, ["store"] = false, ["stream"] = true,
            ["include"] = new JsonArray("reasoning.encrypted_content")
        };
        if (options.ReasoningEffort is { } effort)
            request["reasoning"] = new JsonObject { ["effort"] = effort, ["summary"] = "auto" };
        if (options.Tools is { Count: > 0 } tools)
        {
            request["tools"] = new JsonArray(new JsonObject
            {
                ["type"] = "namespace", ["name"] = "di", ["description"] = "Di harness tools, executed locally.",
                ["tools"] = new JsonArray(tools.Select(t => (JsonNode)new JsonObject
                {
                    ["type"] = "function", ["name"] = t.Name, ["description"] = t.Description,
                    ["parameters"] = t.Parameters.DeepClone(), ["strict"] = t.Strict
                }).ToArray())
            });
            request["tool_choice"] = options.ToolChoice switch
            {
                ChatToolChoice.Auto => JsonValue.Create("auto"),
                ChatToolChoice.None => JsonValue.Create("none"),
                ChatToolChoice.Required => JsonValue.Create("required"),
                ChatToolChoice.Function f => new JsonObject { ["type"] = "function", ["name"] = f.Name, ["namespace"] = "di" },
                _ => throw new LlmException("Unsupported tool choice.", LlmErrorCodes.UnsupportedOption)
            };
        }
        return request;
    }

    private static bool IsImageUrl(string value) => value.StartsWith("data:image/", StringComparison.Ordinal) ||
        (Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == "https");
}
