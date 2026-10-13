using System.Text.Json;
using Common.Events;
using Core.AgentLoop;
using Core.Llm;
using Core.Sessions;
using Core.Skills;
using Di.Cli;
using Di.Cli.Modes;

namespace Di.Cli.Tests.Modes;

/// <summary>
/// <see cref="RpcMode"/>（--mode rpc，NDJSON over stdin/stdout）的单元测试。
/// 用 fake 宿主（真实事件总线 + 假会话驱动）验证协议契约（docs/tui-rpc.md）：
/// ready 握手、prompt 的事件流 + result、interrupt → cancelled、shutdown → 优雅退出、
/// 协议错误 → error 消息后继续、set_model / set_skills / clear_history / ping、
/// 以及会话日志（--no-session 关闭）。
/// </summary>
public sealed class RpcModeTests
{
    // ---- 握手与退出 ----

    [Fact]
    public async Task Rpc_EmitsReadyFirst_ThenShutdownExitsZero()
    {
        var (host, _) = Host();
        var (code, output, stderr) = await RunAsync(host, new CliArgs(),
            """{"type":"request","id":1,"method":"shutdown","params":{}}""");

        Assert.Equal(0, code);
        var lines = Lines(output);
        Assert.Equal("""{"type":"ready","version":"0.1.0"}""", lines[0]);
        Assert.Single(lines);   // shutdown 无应答，仅 ready
        Assert.Equal("", stderr);
    }

    [Fact]
    public async Task Rpc_Eof_ExitsZero_WithoutRunningTurn()
    {
        var (host, runner) = Host();
        var (code, output, _) = await RunAsync(host, new CliArgs(), "");

        Assert.Equal(0, code);
        Assert.Empty(runner.Messages);
        Assert.Equal("""{"type":"ready","version":"0.1.0"}""", Lines(output)[0]);
    }

    // ---- prompt：事件流 + result ----

    [Fact]
    public async Task Rpc_Prompt_EmitsEventsThenResult_ExitsZero()
    {
        var (host, runner) = Host();
        var (code, output, stderr) = await RunAsync(host, new CliArgs(),
            """
            {"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
            {"type":"request","id":2,"method":"shutdown","params":{}}
            """);

        Assert.Equal(0, code);
        Assert.Equal(["hi"], runner.Messages);
        var lines = Lines(output);
        Assert.Equal("""{"type":"ready","version":"0.1.0"}""", lines[0]);

        using var evt1 = JsonDocument.Parse(lines[1]);
        Assert.Equal("event", evt1.RootElement.GetProperty("type").GetString());
        Assert.Equal(1, evt1.RootElement.GetProperty("seq").GetInt32());
        var e1 = evt1.RootElement.GetProperty("event");
        Assert.Equal("text_delta", e1.GetProperty("kind").GetString());
        Assert.Equal("回答: hi", e1.GetProperty("delta").GetString());

        using var evt2 = JsonDocument.Parse(lines[2]);
        var e2 = evt2.RootElement.GetProperty("event");
        Assert.Equal("turn_completed", e2.GetProperty("kind").GetString());
        Assert.Equal(1, e2.GetProperty("iteration").GetInt32());
        var usage = e2.GetProperty("usage");
        Assert.Equal(10, usage.GetProperty("input_tokens").GetInt32());
        Assert.Equal(20, usage.GetProperty("output_tokens").GetInt32());
        Assert.False(usage.TryGetProperty("total_tokens", out _), "null 键省略");
        Assert.False(e2.TryGetProperty("cost", out _), "cost 为 null 时省略键");
        Assert.Equal("stop", e2.GetProperty("finish_reason").GetString());

        using var result = JsonDocument.Parse(lines[3]);
        Assert.Equal("result", result.RootElement.GetProperty("type").GetString());
        Assert.Equal(3, result.RootElement.GetProperty("seq").GetInt32());
        var r = result.RootElement.GetProperty("result");
        Assert.Equal("回答: hi", r.GetProperty("answer").GetString());
        Assert.Equal("answer", r.GetProperty("stop_reason").GetString());
        Assert.Equal(1, r.GetProperty("iterations").GetInt32());
        Assert.Equal(10, r.GetProperty("usage").GetProperty("input_tokens").GetInt32());
        Assert.Equal("", stderr);
    }

    [Fact]
    public async Task Rpc_Prompt_EmitsExactWireSequence()
    {
        // 字节级契约锚定：ready → text_delta → turn_completed → result 的完整线序与字段名。
        // 与 docs/tui-rpc.md §2 逐字段对应；修改协议时先改这条，再改实现。
        var (host, _) = Host();
        var (code, output, _) = await RunAsync(host, new CliArgs(),
            """
            {"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
            {"type":"request","id":2,"method":"shutdown","params":{}}
            """);

        Assert.Equal(0, code);
        var expected =
            """
            {"type":"ready","version":"0.1.0"}
            {"type":"event","seq":1,"event":{"kind":"text_delta","delta":"回答: hi"}}
            {"type":"event","seq":2,"event":{"kind":"turn_completed","iteration":1,"usage":{"input_tokens":10,"output_tokens":20},"finish_reason":"stop"}}
            {"type":"result","seq":3,"result":{"answer":"回答: hi","stop_reason":"answer","iterations":1,"usage":{"input_tokens":10,"output_tokens":20}}}
            """.Replace("\r\n", "\n").Replace("\n", Environment.NewLine) + Environment.NewLine;
        Assert.Equal(expected, output);
    }

    [Fact]
    public async Task Rpc_Prompt_CostPresent_SerializedAsNumber()
    {
        var (host, _) = Host(cost: new UsageCost(0.1, 0.2, 0, 0));   // Total = 0.3
        var (_, output, _) = await RunAsync(host, new CliArgs(),
            """
            {"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
            {"type":"request","id":2,"method":"shutdown","params":{}}
            """);

        var lines = Lines(output);
        using var result = JsonDocument.Parse(lines[^1]);
        Assert.Equal(0.3, result.RootElement.GetProperty("result").GetProperty("cost").GetDouble(), precision: 10);
    }

    [Fact]
    public async Task Rpc_ReasoningAndToolCallDeltas_EmittedAsDeltaEvents()
    {
        var bus = new InMemoryEventBus();
        var runner = new DeltaRunner { Bus = bus };
        var host = new CliHost(runner, bus, new FakeLlm([]), [], new ReplOptions(), null);
        var (code, output, _) = await RunAsync(host, new CliArgs(),
            """
            {"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
            {"type":"request","id":2,"method":"shutdown","params":{}}
            """);

        Assert.Equal(0, code);
        var lines = Lines(output);

        using var reason = JsonDocument.Parse(lines[1]);
        var reasonEvt = reason.RootElement.GetProperty("event");
        Assert.Equal("reasoning_delta", reasonEvt.GetProperty("kind").GetString());
        Assert.Equal("思考中", reasonEvt.GetProperty("delta").GetString());

        using var call = JsonDocument.Parse(lines[2]);
        var callEvt = call.RootElement.GetProperty("event");
        Assert.Equal("tool_call_delta", callEvt.GetProperty("kind").GetString());
        Assert.Equal("c1", callEvt.GetProperty("id").GetString());
        Assert.Equal("echo", callEvt.GetProperty("name").GetString());
        Assert.Equal("""{"x":1}""", callEvt.GetProperty("arguments").GetString());

        using var turn = JsonDocument.Parse(lines[3]);
        var turnEvt = turn.RootElement.GetProperty("event");
        Assert.Equal("turn_completed", turnEvt.GetProperty("kind").GetString());
        Assert.Equal(5, turnEvt.GetProperty("usage").GetProperty("reasoning_tokens").GetInt32());
    }

    [Fact]
    public async Task Rpc_ToolLifecycle_EmittedAsToolStartedAndCompleted()
    {
        var bus = new InMemoryEventBus();
        var runner = new ToolRunner { Bus = bus };
        var host = new CliHost(runner, bus, new FakeLlm([]), [], new ReplOptions(), null);
        var (code, output, _) = await RunAsync(host, new CliArgs(),
            """
            {"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
            {"type":"request","id":2,"method":"shutdown","params":{}}
            """);

        Assert.Equal(0, code);
        var lines = Lines(output);

        using var started = JsonDocument.Parse(lines[1]);
        var s = started.RootElement.GetProperty("event");
        Assert.Equal("tool_started", s.GetProperty("kind").GetString());
        Assert.Equal("echo", s.GetProperty("call").GetProperty("name").GetString());

        using var completed = JsonDocument.Parse(lines[2]);
        var c = completed.RootElement.GetProperty("event");
        Assert.Equal("tool_completed", c.GetProperty("kind").GetString());
        Assert.Equal("obs", c.GetProperty("observation").GetString());
        Assert.False(c.GetProperty("is_error").GetBoolean());
    }

    // ---- interrupt ----

    [Fact]
    public async Task Rpc_InterruptDuringTurn_EmitsResultCancelled_ExitsZero()
    {
        var bus = new InMemoryEventBus();
        var host = new CliHost(new BlockingRunner(), bus, new FakeLlm([]), [], new ReplOptions(), null);
        var (code, output, _) = await RunAsync(host, new CliArgs(),
            """
            {"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
            {"type":"request","id":2,"method":"interrupt","params":{}}
            """);

        Assert.Equal(0, code);
        var lines = Lines(output);
        using var result = JsonDocument.Parse(lines[^1]);
        Assert.Equal("result", result.RootElement.GetProperty("type").GetString());
        Assert.Equal("cancelled", result.RootElement.GetProperty("result").GetProperty("stop_reason").GetString());
    }

    // ---- 会话级命令 ----

    [Fact]
    public async Task Rpc_SetModel_ChangesCurrentModel()
    {
        var (host, runner) = Host();
        var (code, _, _) = await RunAsync(host, new CliArgs(),
            """
            {"type":"request","id":1,"method":"set_model","params":{"model":"deepseek-v4-pro"}}
            {"type":"request","id":2,"method":"shutdown","params":{}}
            """);

        Assert.Equal(0, code);
        Assert.Equal("deepseek-v4-pro", runner.CurrentModel);
    }

    [Fact]
    public async Task Rpc_SetSkills_ResolvesNamesToKnownSkills()
    {
        var bus = new InMemoryEventBus();
        var skill = new Skill { Name = "backend-tests", Description = "跑后端测试", Instructions = "dotnet test" };
        var runner = new FakeRunner { Bus = bus };
        var host = new CliHost(runner, bus, new FakeLlm([]), [skill], new ReplOptions(), null);
        var (code, _, _) = await RunAsync(host, new CliArgs(),
            """
            {"type":"request","id":1,"method":"set_skills","params":{"names":["backend-tests","不存在"]}}
            {"type":"request","id":2,"method":"shutdown","params":{}}
            """);

        Assert.Equal(0, code);
        Assert.Equal(["backend-tests"], runner.ActiveSkills.Select(s => s.Name));   // 未知名被过滤
    }

    [Fact]
    public async Task Rpc_ClearHistory_CallsResetHistory()
    {
        var bus = new InMemoryEventBus();
        var runner = new ClearHistoryRunner();
        var host = new CliHost(runner, bus, new FakeLlm([]), [], new ReplOptions(), null);
        var (code, _, _) = await RunAsync(host, new CliArgs(),
            """
            {"type":"request","id":1,"method":"clear_history","params":{}}
            {"type":"request","id":2,"method":"shutdown","params":{}}
            """);

        Assert.Equal(0, code);
        Assert.Equal(1, runner.ResetCalls);
    }

    [Fact]
    public async Task Rpc_Ping_ProducesNoReply()
    {
        var (host, _) = Host();
        var (code, output, _) = await RunAsync(host, new CliArgs(),
            """
            {"type":"request","id":1,"method":"ping","params":{}}
            {"type":"request","id":2,"method":"shutdown","params":{}}
            """);

        Assert.Equal(0, code);
        Assert.Single(Lines(output));   // 仅 ready，ping 无应答
    }

    // ---- 失败路径 ----

    [Fact]
    public async Task Rpc_RunnerThrows_EmitsResultError_ExitsZero()
    {
        var bus = new InMemoryEventBus();
        var host = new CliHost(new ThrowingRunner(), bus, new FakeLlm([]), [], new ReplOptions(), null);
        var (code, output, _) = await RunAsync(host, new CliArgs(),
            """
            {"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
            {"type":"request","id":2,"method":"shutdown","params":{}}
            """);

        Assert.Equal(0, code);   // 回合失败是消息不是崩溃：进程仍优雅退出 0
        var lines = Lines(output);
        using var result = JsonDocument.Parse(lines[^1]);
        var r = result.RootElement.GetProperty("result");
        Assert.Equal("error", r.GetProperty("stop_reason").GetString());
        Assert.Equal("model_error", r.GetProperty("failure").GetProperty("code").GetString());
        Assert.Contains("boom", r.GetProperty("failure").GetProperty("message").GetString());
    }

    [Fact]
    public async Task Rpc_StopReasonError_EmitsResultErrorWithFailure()
    {
        var bus = new InMemoryEventBus();
        var runner = new ErrorRunner { Bus = bus };
        var host = new CliHost(runner, bus, new FakeLlm([]), [], new ReplOptions(), null);
        var (code, output, _) = await RunAsync(host, new CliArgs(),
            """
            {"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
            {"type":"request","id":2,"method":"shutdown","params":{}}
            """);

        Assert.Equal(0, code);
        var lines = Lines(output);
        using var result = JsonDocument.Parse(lines[^1]);
        var r = result.RootElement.GetProperty("result");
        Assert.Equal("error", r.GetProperty("stop_reason").GetString());
        Assert.Equal("missing_credential", r.GetProperty("failure").GetProperty("code").GetString());
        Assert.Contains("API Key", r.GetProperty("failure").GetProperty("message").GetString());
    }

    [Fact]
    public async Task Rpc_MalformedJson_EmitsParseError_Continues()
    {
        var (host, runner) = Host();
        var (code, output, _) = await RunAsync(host, new CliArgs(),
            """
            not-json
            {"type":"request","id":2,"method":"shutdown","params":{}}
            """);

        Assert.Equal(0, code);
        Assert.Empty(runner.Messages);   // 解析失败不触发回合
        var lines = Lines(output);
        using var err = JsonDocument.Parse(lines[1]);
        Assert.Equal("error", err.RootElement.GetProperty("type").GetString());
        Assert.Equal("parse_error", err.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Rpc_MissingParams_EmitsInvalidRequest_Continues()
    {
        var (host, runner) = Host();
        var (code, output, _) = await RunAsync(host, new CliArgs(),
            """
            {"type":"request","id":1,"method":"prompt"}
            {"type":"request","id":2,"method":"shutdown","params":{}}
            """);

        Assert.Equal(0, code);
        Assert.Empty(runner.Messages);
        var lines = Lines(output);
        using var err = JsonDocument.Parse(lines[1]);
        Assert.Equal("invalid_request", err.RootElement.GetProperty("code").GetString());
    }

    [Fact]
    public async Task Rpc_UnknownMethod_EmitsError_Continues()
    {
        var (host, _) = Host();
        var (code, output, _) = await RunAsync(host, new CliArgs(),
            """
            {"type":"request","id":1,"method":"bogus","params":{}}
            {"type":"request","id":2,"method":"shutdown","params":{}}
            """);

        Assert.Equal(0, code);
        var lines = Lines(output);
        using var err = JsonDocument.Parse(lines[1]);
        Assert.Equal("unknown_method", err.RootElement.GetProperty("code").GetString());
    }

    // ---- 会话日志 ----

    [Fact]
    public async Task Rpc_WritesSessionLog_ByDefault()
    {
        var root = Directory.CreateTempSubdirectory("di-rpc-session-").FullName;
        try
        {
            var bus = new InMemoryEventBus();
            var host = new CliHost(new FakeRunner { Bus = bus }, bus, new FakeLlm([]), [], new ReplOptions(),
                new SessionLog(new SessionLogOptions { RootDirectory = root }));
            var (code, _, _) = await RunAsync(host, new CliArgs(),
                """
                {"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
                {"type":"request","id":2,"method":"shutdown","params":{}}
                """);

            Assert.Equal(0, code);
            Assert.True(File.Exists(host.SessionLog!.LogFilePath), "rpc 默认应写会话日志");
            var lines = File.ReadAllLines(host.SessionLog.LogFilePath).Where(l => !string.IsNullOrWhiteSpace(l)).ToArray();
            using var complete = JsonDocument.Parse(lines[^1]);
            Assert.Equal("task_complete",
                complete.RootElement.GetProperty("payload").GetProperty("type").GetString());
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task Rpc_NoSession_SkipsWritingLog()
    {
        var root = Directory.CreateTempSubdirectory("di-rpc-nosession-").FullName;
        try
        {
            var bus = new InMemoryEventBus();
            var host = new CliHost(new FakeRunner { Bus = bus }, bus, new FakeLlm([]), [], new ReplOptions(),
                new SessionLog(new SessionLogOptions { RootDirectory = root }));
            var (code, _, _) = await RunAsync(host, new CliArgs { NoSession = true },
                """
                {"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
                {"type":"request","id":2,"method":"shutdown","params":{}}
                """);

            Assert.Equal(0, code);
            Assert.False(File.Exists(host.SessionLog!.LogFilePath), "--no-session 不应创建会话文件");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    // ---- 工具 ----

    private static (CliHost Host, FakeRunner Runner) Host(UsageCost? cost = null)
    {
        var bus = new InMemoryEventBus();
        var runner = new FakeRunner { Bus = bus, Cost = cost };
        return (new CliHost(runner, bus, new FakeLlm([]), [], new ReplOptions(), null), runner);
    }

    private static async Task<(int Code, string Output, string Stderr)> RunAsync(
        CliHost host, CliArgs args, string input)
    {
        var stdout = new StringWriter();
        var stderr = new StringWriter();
        var code = await RpcMode.RunAsync(host, args, new StringReader(input), stdout, stderr);
        return (code, stdout.ToString(), stderr.ToString());
    }

    private static string[] Lines(string output) =>
        output.Replace("\r\n", "\n").TrimEnd('\n').Split('\n');

    /// <summary>发布推理 / 工具参数增量事件的假驱动（验证新增增量事件的线格式）。</summary>
    private sealed class DeltaRunner : IAgentRunner
    {
        public IEventBus? Bus { get; set; }
        public string CurrentModel { get; set; } = "deepseek-flash";
        public IReadOnlyList<Skill> ActiveSkills { get; set; } = [];
        public void ResetHistory() { }

        public async Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
        {
            if (Bus is not null)
            {
                await Bus.PublishAsync(new AgentLoopEvent.ReasoningDelta("思考中"));
                await Bus.PublishAsync(new AgentLoopEvent.ToolCallDelta("c1", "echo", """{"x":1}"""));
                await Bus.PublishAsync(new AgentLoopEvent.TurnCompleted(1,
                    new TokenUsage(10, 20, ReasoningTokens: 5), Cost: null, new FinishReason.Stop()));
            }
            return new AgentResult
            {
                Answer = "ok",
                Trajectory = [ChatMessage.User(userMessage)],
                Iterations = 1,
                Usage = new TokenUsage(10, 20, ReasoningTokens: 5),
                StopReason = AgentStopReason.Answer,
            };
        }
    }

    /// <summary>发布工具生命周期事件的假驱动（验证 tool_started / tool_completed 线格式）。</summary>
    private sealed class ToolRunner : IAgentRunner
    {
        public IEventBus? Bus { get; set; }
        public string CurrentModel { get; set; } = "deepseek-flash";
        public IReadOnlyList<Skill> ActiveSkills { get; set; } = [];
        public void ResetHistory() { }

        public async Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
        {
            if (Bus is not null)
            {
                await Bus.PublishAsync(new AgentLoopEvent.ToolStarted(new ToolCallBlock("c1", "echo", "{}")));
                await Bus.PublishAsync(new AgentLoopEvent.ToolCompleted(new ToolCallBlock("c1", "echo", "{}"), "obs", IsError: false));
                await Bus.PublishAsync(new AgentLoopEvent.TurnCompleted(1, TokenUsage.Zero, Cost: null, new FinishReason.Stop()));
            }
            return new AgentResult
            {
                Answer = "ok",
                Trajectory = [ChatMessage.User(userMessage)],
                Iterations = 1,
                StopReason = AgentStopReason.Answer,
            };
        }
    }

    /// <summary>阻塞直到取消的假驱动（验证 interrupt → result.stop_reason:cancelled）。</summary>
    private sealed class BlockingRunner : IAgentRunner
    {
        public string CurrentModel { get; set; } = "deepseek-flash";
        public IReadOnlyList<Skill> ActiveSkills { get; set; } = [];
        public void ResetHistory() { }

        public async Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);   // 被取消 → OperationCanceledException
            throw new InvalidOperationException("不可达：必须通过取消中断");
        }
    }

    /// <summary>记录 ResetHistory 调用次数的假驱动（验证 clear_history）。</summary>
    private sealed class ClearHistoryRunner : IAgentRunner
    {
        public string CurrentModel { get; set; } = "deepseek-flash";
        public IReadOnlyList<Skill> ActiveSkills { get; set; } = [];
        public int ResetCalls { get; private set; }
        public void ResetHistory() => ResetCalls++;

        public Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
            => Task.FromResult(new AgentResult
            {
                Answer = "",
                Trajectory = [],
                Iterations = 0,
                StopReason = AgentStopReason.Answer,
            });
    }
}
