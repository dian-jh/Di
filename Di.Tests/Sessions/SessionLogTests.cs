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
    public void Ctor_DoesNotCreateOrOverwriteUserConfigJson()
    {
        // config.json 归用户所有：程序只读，不创建、不覆盖（见 docs/di-home.md §4 所有权规则）。
        _ = NewLog();

        Assert.False(File.Exists(Path.Combine(_root, "config.json")));

        File.WriteAllText(Path.Combine(_root, "config.json"), "{\"custom\":true}");
        _ = new SessionLog(new SessionLogOptions { RootDirectory = _root });
        Assert.Equal("{\"custom\":true}", File.ReadAllText(Path.Combine(_root, "config.json")));
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
    public void AppendFailure_WritesTaskFailedRecord()
    {
        // 失败回合也必须落盘（曾几何时 Repl 只在成功时 AppendTurn，报错"查无此证"）。
        var log = NewLog();
        log.StartSession();
        log.AppendFailure("你好", "The response ended prematurely.", DateTimeOffset.UtcNow.AddSeconds(-1));

        var records = ReadRecords(log.LogFilePath);
        var types = records.Select(r => r.GetProperty("type").GetString()!).ToArray();
        Assert.Equal(
        [
            "session_meta", "event_msg", "turn_context", "response_item", "event_msg",
        ], types);

        Assert.Equal("task_started", Payload(records[1]).GetProperty("type").GetString());

        var user = Payload(records[3]);
        Assert.Equal("message", user.GetProperty("type").GetString());
        Assert.Equal("user", user.GetProperty("role").GetString());
        Assert.Equal("你好", user.GetProperty("content")[0].GetProperty("text").GetString());

        var failed = Payload(records[4]);
        Assert.Equal("task_failed", failed.GetProperty("type").GetString());
        Assert.Equal("The response ended prematurely.", failed.GetProperty("error").GetString());
        Assert.True(failed.GetProperty("duration_ms").GetInt64() >= 0);
    }

    [Fact]
    public void AppendTurn_WithHistory_RecordsOnlyNewMessages()
    {
        var log = NewLog();
        log.StartSession();

        var history = new ChatMessage[] { ChatMessage.User("旧问题"), ChatMessage.Assistant("旧回答") };
        log.AppendTurn(new AgentResult
        {
            Answer = "新回答",
            Trajectory = [.. history, ChatMessage.User("新问题"), ChatMessage.Assistant("新回答")],
            History = history,   // 上回合已写入会话文件，本回合不应重复记录
            Iterations = 1,
            StopReason = AgentStopReason.Answer,
        }, DateTimeOffset.UtcNow);

        var messageTexts = ReadRecords(log.LogFilePath)
            .Where(r => r.GetProperty("type").GetString() == "response_item")
            .Select(r => r.GetProperty("payload"))
            .Where(p => p.GetProperty("type").GetString() == "message")
            .Select(p => p.GetProperty("content")[0].GetProperty("text").GetString())
            .ToArray();
        Assert.Equal(["新问题", "新回答"], messageTexts);
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
    public void AppendTurn_TaskComplete_IncludesCost()
    {
        var log = NewLog();
        log.StartSession();
        log.AppendTurn(new AgentResult
        {
            Answer = "ok",
            Trajectory = [ChatMessage.User("你好")],
            Iterations = 1,
            StopReason = AgentStopReason.Answer,
            Cost = new UsageCost(1.5, 2.5, 0.25, 0),
        }, DateTimeOffset.UtcNow);

        var complete = TaskCompletePayload(ReadRecords(log.LogFilePath));
        var cost = complete.GetProperty("cost");
        Assert.Equal(1.5, cost.GetProperty("input").GetDouble());
        Assert.Equal(2.5, cost.GetProperty("output").GetDouble());
        Assert.Equal(0.25, cost.GetProperty("cache_read").GetDouble());
        Assert.Equal(4.25, cost.GetProperty("total").GetDouble());
    }

    [Fact]
    public void AppendTurn_NoCost_OmitsCostField()
    {
        var log = NewLog();
        log.StartSession();
        log.AppendTurn(new AgentResult
        {
            Answer = "ok",
            Trajectory = [ChatMessage.User("你好")],
            Iterations = 1,
            StopReason = AgentStopReason.Answer,
        }, DateTimeOffset.UtcNow);

        var complete = TaskCompletePayload(ReadRecords(log.LogFilePath));
        Assert.False(complete.TryGetProperty("cost", out _));
    }

    [Fact]
    public void SessionId_IsUniquePerInstance()
    {
        Assert.NotEqual(NewLog().SessionId, NewLog().SessionId);
    }

    private static JsonElement Payload(JsonElement record) => record.GetProperty("payload");

    /// <summary>取最后一个 event_msg 信封中 type=task_complete 的 payload（event_msg 才携带事件类型）。</summary>
    private static JsonElement TaskCompletePayload(JsonElement[] records) =>
        records
            .Where(r => r.GetProperty("type").GetString() == "event_msg")
            .Select(Payload)
            .Last(p => p.GetProperty("type").GetString() == "task_complete");

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
