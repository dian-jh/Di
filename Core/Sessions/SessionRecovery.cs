using System.Text.Json;
using Core.Llm;

namespace Core.Sessions;

/// <summary>Reads durable ReAct checkpoints. Tool intents without durable outcomes are never replayed.</summary>
public static class SessionRecovery
{
    public static IReadOnlyList<ChatMessage> Load(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        var bytes = File.ReadAllBytes(path);
        var text = System.Text.Encoding.UTF8.GetString(bytes);
        // Ignore only a torn final append; malformed complete/interior lines are evidence corruption.
        if (text.Length > 0 && text[^1] != '\n')
        {
            var lastNewline = text.LastIndexOf('\n');
            text = lastNewline < 0 ? "" : text[..(lastNewline + 1)];
        }

        var trajectory = new List<ChatMessage>();
        var hasCheckpoint = false;
        var started = new Dictionary<string, string>(StringComparer.Ordinal);
        var activeCalls = new HashSet<string>(StringComparer.Ordinal);
        var completedCalls = new HashSet<string>(StringComparer.Ordinal);
        var lineNumber = 0;
        foreach (var line in text.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            lineNumber++;
            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); }
            catch (JsonException ex) { throw new InvalidDataException($"Invalid session record at line {lineNumber}.", ex); }
            using (doc)
            {
                var root = doc.RootElement;
                var type = root.GetProperty("type").GetString();
                var payload = root.GetProperty("payload");
                switch (type)
                {
                    case "checkpoint_turn_started":
                        if (started.Count > 0)
                            throw new InvalidOperationException("Recovery stopped because a tool outcome is unknown: " + string.Join(", ", started.Keys));
                        hasCheckpoint = true;
                        activeCalls.Clear();
                        completedCalls.Clear();
                        trajectory.Clear();
                        foreach (var item in payload.GetProperty("history").EnumerateArray()) trajectory.Add(ReadMessage(item));
                        trajectory.Add(ReadMessage(payload.GetProperty("user")));
                        break;
                    case "trajectory_checkpoint":
                    {
                        var checkpointMessage = ReadMessage(payload.GetProperty("message"));
                        if (checkpointMessage is AssistantMessage assistantMessage)
                        {
                            if (started.Count > 0)
                                throw new InvalidOperationException("Recovery stopped because a tool outcome is unknown: " + string.Join(", ", started.Keys));
                            activeCalls = assistantMessage.ToolCalls.Select(call => call.Id).ToHashSet(StringComparer.Ordinal);
                            completedCalls.Clear();
                        }
                        trajectory.Add(checkpointMessage);
                        break;
                    }
                    case "checkpoint_tool_started":
                    {
                        var callId = payload.GetProperty("call_id").GetString()!;
                        if (!activeCalls.Contains(callId) || completedCalls.Contains(callId) ||
                            !started.TryAdd(callId, payload.GetProperty("name").GetString()!))
                            throw new InvalidDataException($"Orphan or duplicate tool-start record '{callId}'.");
                        break;
                    }
                    case "checkpoint_tool_completed":
                    {
                        var id = payload.GetProperty("call_id").GetString()!;
                        if (!started.Remove(id))
                            throw new InvalidDataException($"Tool completion '{id}' has no matching started record.");
                        if (!completedCalls.Add(id))
                            throw new InvalidDataException($"Duplicate tool completion '{id}'.");
                        var completedMessage = ReadMessage(payload.GetProperty("message"));
                        if (completedMessage is not ToolResultMessage completedResult || completedResult.ToolCallId != id)
                            throw new InvalidDataException($"Tool completion record '{id}' contains a mismatched result.");
                        trajectory.Add(completedResult);
                        break;
                    }
                }
            }
        }

        if (started.Count > 0)
            throw new InvalidOperationException("Recovery stopped because tool execution outcome is unknown: " +
                string.Join(", ", started.Select(p => $"{p.Key} ({p.Value})")));
        if (!hasCheckpoint)
            throw new InvalidOperationException("This session has no recovery checkpoints. Sessions written by older versions cannot be resumed.");

        // Validate and repair each assistant call batch locally; call ids may legally repeat in later responses.
        var repaired = new List<ChatMessage>();
        for (var i = 0; i < trajectory.Count;)
        {
            if (trajectory[i] is AssistantMessage { ToolCalls.Count: > 0 } assistant)
            {
                var calls = assistant.ToolCalls.Select(c => c.Id).ToHashSet(StringComparer.Ordinal);
                if (calls.Count != assistant.ToolCalls.Count)
                    throw new InvalidDataException("Duplicate tool call id in one assistant checkpoint.");
                repaired.Add(assistant);
                i++;
                var results = new HashSet<string>(StringComparer.Ordinal);
                while (i < trajectory.Count && trajectory[i] is ToolResultMessage toolResult)
                {
                    if (!calls.Contains(toolResult.ToolCallId) || !results.Add(toolResult.ToolCallId))
                        throw new InvalidDataException($"Orphan or duplicate tool result '{toolResult.ToolCallId}'.");
                    repaired.Add(toolResult);
                    i++;
                }
                foreach (var call in assistant.ToolCalls)
                    if (!results.Contains(call.Id))
                        repaired.Add(ChatMessage.Tool(call.Id,
                            "Recovery note: this tool call was not executed before the checkpoint. Decide whether it is still needed."));
                continue;
            }
            if (trajectory[i] is ToolResultMessage orphan)
                throw new InvalidDataException($"Tool result '{orphan.ToolCallId}' has no preceding assistant call batch.");
            repaired.Add(trajectory[i++]);
        }
        return repaired;
    }

    private static ChatMessage ReadMessage(JsonElement value)
    {
        var role = value.GetProperty("role").GetString();
        if (role == "system") return ChatMessage.System(value.GetProperty("text").GetString() ?? "");
        if (role == "tool") return ChatMessage.Tool(value.GetProperty("call_id").GetString()!, value.GetProperty("text").GetString() ?? "",
            value.TryGetProperty("is_error", out var error) && error.GetBoolean());
        var blocks = new List<IContentBlock>();
        foreach (var block in value.GetProperty("blocks").EnumerateArray())
        {
            switch (block.GetProperty("type").GetString())
            {
                case "text": blocks.Add(new TextBlock(block.GetProperty("text").GetString() ?? "")); break;
                case "reasoning": blocks.Add(new ReasoningBlock(block.GetProperty("text").GetString() ?? "")); break;
                case "tool_call": blocks.Add(new ToolCallBlock(block.GetProperty("id").GetString()!, block.GetProperty("name").GetString()!, block.GetProperty("arguments").GetString()!)); break;
                case "image": blocks.Add(new ImageBlock(block.GetProperty("attachment_id").GetString()!, block.TryGetProperty("detail", out var detail) ? detail.GetString() : null)); break;
                case "file": blocks.Add(new FileBlock(block.GetProperty("attachment_id").GetString()!, block.TryGetProperty("filename", out var filename) ? filename.GetString() : null)); break;
                case "opaque": blocks.Add(new OpaqueBlock(block.GetProperty("unknown_type").GetString()!, block.GetProperty("raw_json").GetString()!)); break;
                default: throw new InvalidDataException("Unknown checkpoint content block type.");
            }
        }
        return role switch
        {
            "user" => new UserMessage(blocks),
            "assistant" => new AssistantMessage(blocks),
            _ => throw new InvalidDataException($"Unknown checkpoint role '{role}'."),
        };
    }
}
