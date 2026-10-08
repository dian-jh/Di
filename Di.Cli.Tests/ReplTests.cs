using Common.Events;
using Core.AgentLoop;
using Core.Llm;
using Di.Cli;

namespace Di.Cli.Tests;

/// <summary>
/// 针对 <see cref="Repl"/>（外层循环）的单元测试。
/// 用假的输入行 / 假的 agent runner / 真实内存事件总线，验证命令处理、回合渲染与退出。
/// </summary>
public sealed class ReplTests
{
    [Fact]
    public async Task Exit_OnExitCommand_StopsWithoutRunningAgent()
    {
        var (repl, output, runner) = Setup("/exit");

        await repl.RunAsync();

        Assert.Empty(runner.Messages);
        Assert.Contains("di>", output.ToString());
    }

    [Fact]
    public async Task Help_PrintsAvailableCommands()
    {
        var (repl, output, _) = Setup("/help", "/exit");

        await repl.RunAsync();

        var text = output.ToString();
        Assert.Contains("/help", text);
        Assert.Contains("/clear", text);
        Assert.Contains("/model", text);
        Assert.Contains("/exit", text);
    }

    [Fact]
    public async Task UnknownCommand_PrintsError()
    {
        var (repl, output, _) = Setup("/bogus", "/exit");

        await repl.RunAsync();

        Assert.Contains("未知命令: /bogus", output.ToString());
    }

    [Fact]
    public async Task ChatTurn_RunsAgent_AndRendersEventsThenAnswer()
    {
        var (repl, output, runner) = Setup("你好", "/exit");

        await repl.RunAsync();

        Assert.Equal(["你好"], runner.Messages);
        var text = output.ToString();
        Assert.Contains("第 1 轮思考完成", text);      // 事件经总线被消费并渲染
        Assert.Contains("回答: 你好", text);            // 最终回答
    }

    [Fact]
    public async Task ModelCommand_ChangesCurrentModel()
    {
        var (repl, _, runner) = Setup("/model deepseek-chat", "/exit");

        await repl.RunAsync();

        Assert.Equal("deepseek-chat", runner.CurrentModel);
    }

    [Fact]
    public async Task ModelCommand_WithoutArgument_PrintsUsage()
    {
        var (repl, output, runner) = Setup("/model", "/exit");

        await repl.RunAsync();

        Assert.Contains("用法: /model", output.ToString());
        Assert.Equal("deepseek-flash", runner.CurrentModel);
    }

    [Fact]
    public async Task ClearCommand_EmitsClearEscapeAndContinues()
    {
        var (repl, output, runner) = Setup("/clear", "hi", "/exit");

        await repl.RunAsync();

        Assert.Contains("\x1b[2J", output.ToString());   // ANSI 清屏
        Assert.Equal(["hi"], runner.Messages);
    }

    [Fact]
    public async Task EmptyLine_IsIgnored()
    {
        var (repl, _, runner) = Setup("", "hi", "/exit");

        await repl.RunAsync();

        Assert.Equal(["hi"], runner.Messages);
    }

    [Fact]
    public async Task Eof_StopsLoopWithoutRunning()
    {
        var (repl, _, runner) = Setup();   // 无输入行 → 立即 EOF

        await repl.RunAsync();

        Assert.Empty(runner.Messages);
    }

    [Fact]
    public async Task ChatTurn_ShowsWorkingIndicator_BeforeEvents_AndErasesIt()
    {
        var (repl, output, _) = Setup("你好", "/exit");

        await repl.RunAsync();

        var text = output.ToString();
        var indicator = text.IndexOf("正在请求模型", StringComparison.Ordinal);
        var answer = text.IndexOf("回答: 你好", StringComparison.Ordinal);
        Assert.True(indicator >= 0, "回合开始应显示进行中指示器");
        Assert.True(answer > indicator, "指示器应先于流式文本出现");
        Assert.Contains("\r\x1b[2K", text);   // 首个内容到达时擦除指示器
    }

    [Fact]
    public async Task ChatTurn_WhenRunnerThrows_ErasesIndicatorAndShowsError()
    {
        var output = new StringWriter();
        var bus = new InMemoryEventBus();
        var runner = new ThrowingRunner();
        var repl = new Repl(runner, bus, new FakeLineReader("你好", "/exit"), output, new ReplOptions());

        await repl.RunAsync();

        var text = output.ToString();
        Assert.Contains("\r\x1b[2K", text);      // 异常路径也要清掉指示器
        Assert.Contains("✗ 运行失败", text);
    }

    private static (Repl Repl, StringWriter Output, FakeRunner Runner) Setup(params string?[] lines)
    {
        var output = new StringWriter();
        var bus = new InMemoryEventBus();
        var runner = new FakeRunner { Bus = bus };
        var repl = new Repl(runner, bus, new FakeLineReader(lines), output, new ReplOptions());
        return (repl, output, runner);
    }

    private sealed class FakeLineReader : ILineReader
    {
        private readonly Queue<string?> _lines;
        public FakeLineReader(params string?[] lines) => _lines = new(lines);

        public Task<string?> ReadLineAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(_lines.Count > 0 ? _lines.Dequeue() : null);
    }

    private sealed class FakeRunner : IAgentRunner
    {
        public IEventBus? Bus { get; set; }

        public string CurrentModel { get; set; } = "deepseek-flash";

        public List<string> Messages { get; } = [];

        public async Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
        {
            Messages.Add(userMessage);
            // 模拟 ReAct 流式：先发布文本增量，再发布回合完成事件。
            if (Bus is not null)
            {
                await Bus.PublishAsync(new AgentLoopEvent.TextDelta($"回答: {userMessage}"));
                await Bus.PublishAsync(new AgentLoopEvent.TurnCompleted(1, TokenUsage.Zero, new FinishReason.Stop()));
            }
            return new AgentResult
            {
                Answer = $"回答: {userMessage}",
                Trajectory = [ChatMessage.User(userMessage)],
                Iterations = 1,
                StopReason = AgentStopReason.Answer,
            };
        }
    }

    private sealed class ThrowingRunner : IAgentRunner
    {
        public string CurrentModel { get; set; } = "deepseek-flash";

        public Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("boom");
    }
}
