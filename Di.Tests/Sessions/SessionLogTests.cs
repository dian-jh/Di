using System.Text.Json;
using Core.AgentLoop;
using Core.Llm;
using Core.Sessions;

namespace Di.Tests.Sessions;

/// <summary>
/// 针对 <see cref="SessionLog"/>（会话持久化）的单元测试。
/// 记录格式参考 codex rollout：{timestamp, ordinal, type, payload}，首行 session_meta。
/// </summary>
public sealed class SessionLogTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("di-sessions-").FullName;

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private SessionLog NewLog() => new(new SessionLogOptions { RootDirectory = _root });

    [Fact]
    public void StartSession_CreatesJsonl_WithSessionMetaFirst()
    {
        var log = NewLog();
        log.StartSession();

        Assert.True(File.Exists(log.LogFilePath));
        var meta = ReadRecords(log.LogFilePath)[0];

        Assert.Equal("session_meta", meta.GetProperty("type").GetString());
        Assert.Equal(0, meta.GetProperty("ordinal").GetInt64());

        var payload = meta.GetProperty("payload");
        Assert.Equal(log.SessionId, payload.GetProperty("session_id").GetString());
        Assert.Equal(log.SessionId, payload.GetProperty("id").GetString());
        Assert.Equal(Environment.CurrentDirectory, payload.GetProperty("cwd").GetString());
        Assert.Equal("di", payload.GetProperty("originator").GetString());
        Assert.Equal("deepseek", payload.GetProperty("model_provider").GetString());
        Assert.Equal("cli", payload.GetProperty("source").GetString());
    }

    [Fact]
    public void StartSession_FileLivesUnderDateDirectory()
    {
        var log = NewLog();
        log.StartSession();

        var now = DateTimeOffset.UtcNow;
        var expectedDir = Path.Combine(_root, "sessions",
            now.ToString("yyyy"), now.ToString("MM"), now.ToString("dd"));

        Assert.Equal(expectedDir, Path.GetDirectoryName(log.LogFilePath));
        Assert.True(Directory.Exists(expectedDir));
        var name = Path.GetFileName(log.LogFilePath);
        Assert.StartsWith("session-", name);
        Assert.EndsWith(".jsonl", name);
    }

    [Fact]
    public void Ctor_CreatesConfigJson_WhenMissing_AndPreservesExisting()
    {
        _ = NewLog();   // 构造即应创建 config.json

        var configPath = Path.Combine(_root, "config.json");
        Assert.True(File.Exists(configPath));

        using var doc = JsonDocument.Parse(File.ReadAllText(configPath));
        Assert.Equal(1, doc.RootElement.GetProperty("schema_version").GetInt32());
        Assert.Equal("0.1.0", doc.RootElement.GetProperty("cli_version").GetString());

        // 已存在的 config.json 不应被覆盖
        File.WriteAllText(configPath, "{\"custom\":true}");
        _ = new SessionLog(new SessionLogOptions { RootDirectory = _root });
        Assert.Equal("{\"custom\":true}", File.ReadAllText(configPath));
    }

    [Fact]
    public void AppendTurn_WritesFullTurnSequence()
    {
        var log = NewLog();
        log.StartSession();

        var trajectory = new ChatMessage[]
        {
            ChatMessage.User("你好"),
            ChatMessage.Assistant("我先查一下", reasoning: "思考中", toolCalls:
                [new ToolCallBlock("c1", "bash", "{\"command\":\"dir\"}")]),
            ChatMessage.Tool("c1", "目录内容"),
        };
        log.AppendTurn(new AgentResult
        {
            Answer = "我先查一下",
            Trajectory = trajectory,
            Iterations = 1,
            StopReason = AgentStopReason.Answer,
        }, DateTimeOffset.UtcNow.AddSeconds(-2));

        var records = ReadRecords(log.LogFilePath);
        var types = records.Select(r => r.GetProperty("type").GetString()!).ToArray();
        Assert.Equal(
        [
            "session_meta", "event_msg", "turn_context",
            "response_item", "response_item", "response_item", "response_item", "response_item",
            "event_msg",
        ], types);

        Assert.Equal("task_started", Payload(records[1]).GetProperty("type").GetString());

        var user = Payload(records[3]);
        Assert.Equal("message", user.GetProperty("type").GetString());
        Assert.Equal("user", user.GetProperty("role").GetString());
        Assert.Equal("你好", user.GetProperty("content")[0].GetProperty("text").GetString());

        Assert.Equal("reasoning", Payload(records[4]).GetProperty("type").GetString());

        var assistant = Payload(records[5]);
        Assert.Equal("message", assistant.GetProperty("type").GetString());
        Assert.Equal("assistant", assistant.GetProperty("role").GetString());

        var call = Payload(records[6]);
        Assert.Equal("function_call", call.GetProperty("type").GetString());
        Assert.Equal("c1", call.GetProperty("call_id").GetString());
        Assert.Equal("bash", call.GetProperty("name").GetString());
        Assert.Equal("{\"command\":\"dir\"}", call.GetProperty("arguments").GetString());

        var output = Payload(records[7]);
        Assert.Equal("function_call_output", output.GetProperty("type").GetString());
        Assert.Equal("c1", output.GetProperty("call_id").GetString());
        Assert.Equal("目录内容", output.GetProperty("output").GetString());

        var complete = Payload(records[8]);
        Assert.Equal("task_complete", complete.GetProperty("type").GetString());
        Assert.Equal("我先查一下", complete.GetProperty("last_agent_message").GetString());
        Assert.True(complete.GetProperty("duration_ms").GetInt64() >= 0);
    }

    [Fact]
    public void AppendTurn_OrdinalsMonotonicAcrossTurns()
    {
        var log = NewLog();
        log.StartSession();

        var turn = (string msg) => new AgentResult
        {
            Answer = msg,
            Trajectory = [ChatMessage.User(msg)],
            Iterations = 1,
            StopReason = AgentStopReason.Answer,
        };
        log.AppendTurn(turn("第一问"), DateTimeOffset.UtcNow);
        log.AppendTurn(turn("第二问"), DateTimeOffset.UtcNow);

        var ordinals = ReadRecords(log.LogFilePath).Select(r => r.GetProperty("ordinal").GetInt64()).ToArray();
        Assert.Equal(ordinals.OrderBy(x => x), ordinals);          // 单调不减
        Assert.Equal(0, ordinals[0]);
        Assert.Equal(ordinals.Length - 1, ordinals[^1]);
        Assert.Equal(ordinals.Length, ordinals.Distinct().Count()); // 无重复
    }

    [Fact]
    public void AppendTurn_ChineseContent_WrittenAsUtf8()
    {
        var log = NewLog();
        log.StartSession();
        log.AppendTurn(new AgentResult
        {
            Answer = "系统找不到指定的路径",
            Trajectory = [ChatMessage.User("你好")],
            Iterations = 1,
            StopReason = AgentStopReason.Answer,
        }, DateTimeOffset.UtcNow);

        var text = File.ReadAllText(log.LogFilePath, System.Text.Encoding.UTF8);
        Assert.Contains("你好", text);
        Assert.Contains("系统找不到指定的路径", text);
        Assert.DoesNotContain('�', text);   // 无替换符 → 确实是 UTF-8
    }

    [Fact]
    public void SessionId_IsUniquePerInstance()
    {
        Assert.NotEqual(NewLog().SessionId, NewLog().SessionId);
    }

    private static JsonElement Payload(JsonElement record) => record.GetProperty("payload");

    private static JsonElement[] ReadRecords(string path)
    {
        var result = new List<JsonElement>();
        foreach (var line in File.ReadAllLines(path))
        {
            if (string.IsNullOrWhiteSpace(line))
                continue;
            using var doc = JsonDocument.Parse(line);
            result.Add(doc.RootElement.Clone());
        }
        return result.ToArray();
    }
}
