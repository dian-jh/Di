using System.Security.Cryptography;
using System.Text.Json;
using Core.Llm;
using Core.Sessions;

if (args.Length < 2) throw new ArgumentException("usage: write <root> | read <file>");
switch (args[0])
{
    case "write":
    {
        var log = new SessionLog(new SessionLogOptions { RootDirectory = args[1] });
        log.BeginCheckpointTurn("interop user", DateTimeOffset.UtcNow);
        log.AppendCheckpointMessage(ChatMessage.Assistant(
            "interop answer", "private reasoning",
            [new ToolCallBlock("call-1", "echo", "{\"value\":\"雪\"}")]));
        log.CheckpointToolStarted(new ToolCallBlock("call-1", "echo", "{\"value\":\"雪\"}"));
        if (args.Length < 3 || args[2] != "incomplete")
        {
            log.CheckpointToolCompleted(ChatMessage.Tool("call-1", "tool result"));
            log.CompleteCheckpointTurn(new Core.AgentLoop.AgentResult
            {
                Answer = "interop answer",
                Trajectory = [],
                History = [],
                Usage = new Core.Llm.TokenUsage(0, 0),
                Iterations = 1,
                StopReason = Core.AgentLoop.AgentStopReason.Answer,
            });
        }
        Console.WriteLine(log.LogFilePath);
        break;
    }
    case "read":
    {
        var path = args[1];
        var before = SHA256.HashData(File.ReadAllBytes(path));
        var messages = SessionLog.LoadRecovery(path);
        var after = SHA256.HashData(File.ReadAllBytes(path));
        if (!before.SequenceEqual(after)) throw new InvalidDataException("reader modified input");
        Console.WriteLine(JsonSerializer.Serialize(messages.Select(m => (object)(m switch
        {
            UserMessage u => new { role = "user", text = u.GetText() },
            AssistantMessage a => new { role = "assistant", text = a.GetText(), reasoning = a.Reasoning,
                tool_calls = a.ToolCalls.Select(c => new { id = c.Id, name = c.Name, arguments = c.Arguments }) },
            ToolResultMessage t => new { role = "tool", text = t.Content, call_id = t.ToolCallId, is_error = t.IsError },
            _ => throw new InvalidDataException($"unexpected message {m.GetType().Name}"),
        }))));
        break;
    }
    default: throw new ArgumentException($"unknown command: {args[0]}");
}
