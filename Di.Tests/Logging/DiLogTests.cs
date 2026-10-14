using Common.Events;
using Core.AgentLoop;
using Core.Llm;
using Core.Logging;

namespace Di.Tests.Logging;

/// <summary>
/// 针对 <see cref="DiLog"/>（jcode 格式文本日志）的单元测试。
/// 格式参考 C:\Users\52143\.jcode\logs：每行 [yyyy-MM-dd HH:mm:ss.fff] [LEVEL] message，
/// 落在 ~/.di/logs/di-YYYY-MM-DD.log（每日一个文件，按 Clock 轮转）。
/// </summary>
public sealed class DiLogTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("di-log-").FullName;

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private static DiLogOptions Options(string root) => new() { RootDirectory = root };

    private static string LogFile(string root, string date) => Path.Combine(root, "logs", $"di-{date}.log");

    [Fact]
    public void Log_WritesJcodeFormatLine()
    {
        var log = new DiLog(Options(_root));
        log.Log(LogLevel.Info, "di starting");
        log.Dispose();

        var lines = ReadLines(LogFile(_root, DateTimeOffset.Now.ToString("yyyy-MM-dd")));
        Assert.Matches(@"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[INFO\] di starting$", lines[0]);
    }

    [Fact]
    public void Log_WritesToDiLogsDateFile()
    {
        var log = new DiLog(Options(_root));
        log.Log(LogLevel.Info, "hi");
        log.Dispose();

        var file = LogFile(_root, DateTimeOffset.Now.ToString("yyyy-MM-dd"));
        Assert.True(File.Exists(file));
        Assert.Equal("di-" + DateTimeOffset.Now.ToString("yyyy-MM-dd") + ".log", Path.GetFileName(file));
    }

    [Fact]
    public void Log_RotatesFileWhenDateChanges()
    {
        var now = new DateTimeOffset(2026, 10, 14, 11, 35, 59, TimeSpan.Zero);
        var log = new DiLog(new DiLogOptions { RootDirectory = _root, Clock = () => now });

        log.Log(LogLevel.Info, "day one");
        now = now.AddDays(1);
        log.Log(LogLevel.Info, "day two");

        // 注意：Dispose 会写 di exiting 到当日文件，须在 Dispose 前读取断言（逐行 flush + FileShare.ReadWrite）。
        Assert.EndsWith("day one", Assert.Single(ReadLines(LogFile(_root, "2026-10-14"))));
        Assert.EndsWith("day two", Assert.Single(ReadLines(LogFile(_root, "2026-10-15"))));
        log.Dispose();
    }

    [Fact]
    public async Task UserInputToModelResponse_WritesCompleteTimeline()
    {
        var bus = new InMemoryEventBus();
        var log = new DiLog(Options(_root));
        log.Subscribe(bus);

        await bus.PublishAsync(new RunStarted("你好"));
        await bus.PublishAsync(new ModelCallStarted(1));
        await bus.PublishAsync(new AgentLoopEvent.TurnCompleted(1,
            new TokenUsage(InputTokens: 120, OutputTokens: 85, CacheReadTokens: 900),
            new UsageCost(1.0, 0.5, 0.25, 0), new FinishReason.Stop()));

        // Dispose 会追加 di exiting，须在 Dispose 前读取断言。
        var lines = ReadLines(LogFile(_root, DateTimeOffset.Now.ToString("yyyy-MM-dd")));
        log.Dispose();
        Assert.Equal(3, lines.Length);
        Assert.Contains("[INFO]", lines[0]);
        Assert.Contains("run: started", lines[0]);
        Assert.Contains("你好", lines[0]);
        Assert.Contains("llm: call_started iteration=1", lines[1]);
        Assert.Contains("llm: call_completed iteration=1", lines[2]);
        Assert.Contains("duration_ms=", lines[2]);
        Assert.Contains("tokens_in=120", lines[2]);
        Assert.Contains("tokens_out=85", lines[2]);
        Assert.Contains("cache_read=900", lines[2]);
        Assert.Contains("finish=stop", lines[2]);
    }

    [Fact]
    public async Task RunFailed_WritesErrorLineWithDuration()
    {
        var bus = new InMemoryEventBus();
        var log = new DiLog(Options(_root));
        log.Subscribe(bus);

        await bus.PublishAsync(new ModelCallStarted(1));
        await bus.PublishAsync(new AgentLoopEvent.RunFailed(new LlmFailure("no api key", LlmErrorCodes.MissingCredential)));

        var lines = ReadLines(LogFile(_root, DateTimeOffset.Now.ToString("yyyy-MM-dd")));
        log.Dispose();
        Assert.Equal(2, lines.Length);
        Assert.Contains("[ERROR]", lines[1]);
        Assert.Contains("llm: run_failed", lines[1]);
        Assert.Contains("code=", lines[1]);
        Assert.Contains("error=no api key", lines[1]);
        Assert.Contains("duration_ms=", lines[1]);
    }

    [Fact]
    public async Task ToolStartedCompleted_WritesInfoAndWarnLines()
    {
        var bus = new InMemoryEventBus();
        var log = new DiLog(Options(_root));
        log.Subscribe(bus);

        var call = new ToolCallBlock("c1", "bash", """{"command":"dir"}""");
        await bus.PublishAsync(new AgentLoopEvent.ToolStarted(call));
        await bus.PublishAsync(new AgentLoopEvent.ToolCompleted(call, "目录内容", IsError: false));
        await bus.PublishAsync(new AgentLoopEvent.ToolCompleted(call, "error executing tool: boom", IsError: true));

        var lines = ReadLines(LogFile(_root, DateTimeOffset.Now.ToString("yyyy-MM-dd")));
        log.Dispose();
        Assert.Equal(3, lines.Length);
        Assert.Contains("tool: started name=bash", lines[0]);
        Assert.Contains("[INFO]", lines[1]);
        Assert.Contains("tool: completed name=bash", lines[1]);
        Assert.Contains("[WARN]", lines[2]);
        Assert.Contains("tool: failed name=bash", lines[2]);
        Assert.Contains("error=error executing tool: boom", lines[2]);
    }

    [Fact]
    public async Task StreamDeltaEvents_AreSkipped()
    {
        var bus = new InMemoryEventBus();
        var log = new DiLog(Options(_root));
        log.Subscribe(bus);

        // 逐字流增量是噪声（完整文本在 sessions/*.jsonl），不落盘。
        await bus.PublishAsync(new AgentLoopEvent.TextDelta("你"));
        await bus.PublishAsync(new AgentLoopEvent.ReasoningDelta("思"));
        await bus.PublishAsync(new AgentLoopEvent.ToolCallDelta("c1", "bash", "{}"));
        await bus.PublishAsync(new ModelCallStarted(1));
        await bus.PublishAsync(new AgentLoopEvent.TurnCompleted(1, TokenUsage.Zero, null, new FinishReason.Stop()));

        var lines = ReadLines(LogFile(_root, DateTimeOffset.Now.ToString("yyyy-MM-dd")));
        log.Dispose();
        Assert.Equal(2, lines.Length);   // 只留 call_started + call_completed
    }

    [Fact]
    public void UnwritableLogDirectory_DoesNotThrow()
    {
        var blocker = Path.Combine(_root, "blocker");
        File.WriteAllText(blocker, "占用该路径");   // 让 {root}/logs 变成文件下路径 → 创建必败

        var log = new DiLog(new DiLogOptions { RootDirectory = blocker });
        log.Log(LogLevel.Info, "hi");   // 静默兜底，不抛
        log.Dispose();
    }

    [Fact]
    public void Dispose_WritesExitingLine()
    {
        var log = new DiLog(Options(_root));
        log.Log(LogLevel.Info, "work");
        log.Dispose();

        var lines = ReadLines(LogFile(_root, DateTimeOffset.Now.ToString("yyyy-MM-dd")));
        Assert.Equal(2, lines.Length);
        Assert.EndsWith("work", lines[0]);
        Assert.EndsWith("di exiting", lines[1]);
    }

    [Fact]
    public void Dispose_IsIdempotent()
    {
        var log = new DiLog(Options(_root));
        log.Log(LogLevel.Info, "work");
        log.Dispose();
        log.Dispose();   // 二次 Dispose 不抛、不重复写 exiting

        var lines = ReadLines(LogFile(_root, DateTimeOffset.Now.ToString("yyyy-MM-dd")));
        Assert.Equal(2, lines.Length);
    }

    /// <summary>在 DiLog 仍持有写入句柄时读取：FileShare.ReadWrite 与 writer 的共享模式兼容
    /// （File.ReadAllLines 的 FileShare.Read 会因拒绝 writer 的写访问而在 Windows 上报"文件被占用"）。</summary>
    private static string[] ReadLines(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(fs);
        var lines = new List<string>();
        while (reader.ReadLine() is { } line)
            lines.Add(line);
        return lines.ToArray();
    }
}