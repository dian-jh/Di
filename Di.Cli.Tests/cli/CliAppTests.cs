using Common.Events;
using Core.AgentLoop;
using Core.Llm;
using Core.Sessions;
using Core.Skills;
using Di.Cli;

namespace Di.Cli.Tests.Cli;

/// <summary>
/// <see cref="CliApp"/> 的单元测试：极薄的分派壳。
/// 短路径（--version / --help / 参数错误 / rpc 未实现）在构建宿主之前返回，绝不碰 DI/文件系统；
/// 需要宿主的路径（--list-models / 交互 REPL）通过注入的 fake 宿主工厂隔离真实配置与磁盘。
/// 悲观覆盖：未知旗标、缺值选项、非法模式、未实现模式、空 stdin。
/// </summary>
public sealed class CliAppTests
{
    private const bool Tty = true;

    private static (CliApp App, StringWriter Out, StringWriter Err, HostFactory Factory) Setup(CliHost? host = null)
    {
        var stdout = new StringWriter();
        var stderr = new StringWriter();
        var factory = new HostFactory(host);
        return (new CliApp(factory.Create), stdout, stderr, factory);
    }

    // ---- 短路径：不构建宿主 ----

    [Fact]
    public async Task Version_PrintsSemver_ExitsZero_WithoutBuildingHost()
    {
        var (app, stdout, stderr, factory) = Setup();

        var code = await app.RunAsync(["--version"], TextReader.Null, stdout, stderr, Tty, Tty);

        Assert.Equal(0, code);
        Assert.Matches(@"^\d+\.\d+\.\d+", stdout.ToString().Trim());
        Assert.Equal("", stderr.ToString());
        Assert.Equal(0, factory.Calls);   // 版本路径不得构建宿主
    }

    [Fact]
    public async Task Info_PrintsEnvironmentAndEffectiveConfig_ExitsZero_WithoutBuildingHost()
    {
        var (app, stdout, stderr, factory) = Setup();

        var code = await app.RunAsync(["--info"], TextReader.Null, stdout, stderr, Tty, Tty);

        Assert.Equal(0, code);
        var text = stdout.ToString();
        Assert.Contains("版本", text);
        Assert.Contains("生效配置", text);
        Assert.Contains("MaxIterations", text);
        Assert.Contains("DefaultModel", text);
        Assert.Contains("Shell 工具", text);
        Assert.Equal("", stderr.ToString());
        Assert.Equal(0, factory.Calls);   // 信息路径不得构建宿主
    }

    [Fact]
    public async Task Help_PrintsUsage_ExitsZero_WithoutBuildingHost()
    {
        var (app, stdout, stderr, factory) = Setup();

        var code = await app.RunAsync(["--help"], TextReader.Null, stdout, stderr, Tty, Tty);

        Assert.Equal(0, code);
        var text = stdout.ToString();
        Assert.Contains("用法", text);
        Assert.Contains("--version", text);
        Assert.Contains("--model", text);
        Assert.Equal(0, factory.Calls);
    }

    [Fact]
    public async Task ShortHelp_PrintsUsage_ExitsZero()
    {
        var (app, stdout, _, factory) = Setup();

        var code = await app.RunAsync(["-h"], TextReader.Null, stdout, new StringWriter(), Tty, Tty);

        Assert.Equal(0, code);
        Assert.Contains("用法", stdout.ToString());
        Assert.Equal(0, factory.Calls);
    }

    [Fact]
    public async Task UnknownFlag_ErrorToStderr_ExitsOne_WithoutBuildingHost()
    {
        var (app, stdout, stderr, factory) = Setup();

        var code = await app.RunAsync(["--bogus"], TextReader.Null, stdout, stderr, Tty, Tty);

        Assert.Equal(1, code);
        Assert.Contains("--bogus", stderr.ToString());
        Assert.Equal(0, factory.Calls);
    }

    [Fact]
    public async Task MissingValue_ErrorToStderr_ExitsOne()
    {
        var (app, stdout, stderr, factory) = Setup();

        var code = await app.RunAsync(["--model"], TextReader.Null, stdout, stderr, Tty, Tty);

        Assert.Equal(1, code);
        Assert.Contains("缺少值", stderr.ToString());
        Assert.Equal(0, factory.Calls);
    }

    [Fact]
    public async Task InvalidMode_ErrorToStderr_ExitsOne()
    {
        var (app, stdout, stderr, factory) = Setup();

        var code = await app.RunAsync(["--mode", "nope"], TextReader.Null, stdout, stderr, Tty, Tty);

        Assert.Equal(1, code);
        Assert.Contains("nope", stderr.ToString());
        Assert.Equal(0, factory.Calls);
    }

    [Fact]
    public async Task RpcMode_BuildsHost_EmitsReady_ExitsZero()
    {
        // M1：--mode rpc 已实现，需要宿主（组合根）；stdin 经管道喂入一条 shutdown 请求，
        // stdout 首先应出现 ready（协议握手），随后优雅退出 0。
        var bus = new InMemoryEventBus();
        var host = new CliHost(new FakeRunner { Bus = bus }, bus, new FakeLlm([]), [], new ReplOptions(), null);
        var (app, stdout, stderr, factory) = Setup(host);
        var stdin = new StringReader("""{"type":"request","id":1,"method":"shutdown","params":{}}""");

        var code = await app.RunAsync(["--mode", "rpc"], stdin, stdout, stderr, Tty, Tty);

        Assert.Equal(0, code);
        Assert.Contains(""""type":"ready"""" , stdout.ToString());
        Assert.Equal("", stderr.ToString());
        Assert.Equal(1, factory.Calls);   // rpc 路径构建宿主
    }

    // ---- 需要宿主的路径：注入 fake 宿主 ----

    [Fact]
    public async Task ListModels_PrintsModels_ExitsZero()
    {
        var models = new List<LlmModelInfo>
        {
            new("deepseek", "deepseek-chat", "DeepSeek Chat"),
            new("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro"),
        };
        var (app, stdout, stderr, factory) = Setup(Host(models));

        var code = await app.RunAsync(["--list-models"], TextReader.Null, stdout, stderr, Tty, Tty);

        Assert.Equal(0, code);
        var text = stdout.ToString();
        Assert.Contains("deepseek-chat", text);
        Assert.Contains("DeepSeek V4 Pro", text);
        Assert.Equal(1, factory.Calls);
    }

    [Fact]
    public async Task ListModels_WithPattern_FiltersByIdOrProvider()
    {
        var models = new List<LlmModelInfo>
        {
            new("deepseek", "deepseek-chat", "DeepSeek Chat"),
            new("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro"),
        };
        var (app, stdout, _, factory) = Setup(Host(models));

        var code = await app.RunAsync(["--list-models", "v4"], TextReader.Null, stdout, new StringWriter(), Tty, Tty);

        Assert.Equal(0, code);
        Assert.Contains("deepseek-v4-pro", stdout.ToString());
        Assert.DoesNotContain("deepseek-chat", stdout.ToString());
    }

    [Fact]
    public async Task ListModels_NoModels_PrintsHint_ExitsZero()
    {
        var (app, stdout, _, factory) = Setup(Host([]));

        var code = await app.RunAsync(["--list-models"], TextReader.Null, stdout, new StringWriter(), Tty, Tty);

        Assert.Equal(0, code);
        Assert.Contains("无可用模型", stdout.ToString());
    }

    // ---- --stats：离线聚合，不构建宿主 ----

    [Fact]
    public async Task Stats_WithSessionFile_PrintsSummary_ExitsZero_WithoutHost()
    {
        var root = Directory.CreateTempSubdirectory("di-cli-stats-").FullName;
        try
        {
            var log = new SessionLog(new SessionLogOptions { RootDirectory = root });
            log.AppendTurn(new AgentResult
            {
                Answer = "ok",
                Trajectory = [ChatMessage.User("hi")],
                Iterations = 1,
                Usage = new TokenUsage(InputTokens: 100, OutputTokens: 50, CacheReadTokens: 900),
                StopReason = AgentStopReason.Answer,
            }, DateTimeOffset.UtcNow);
            var (app, stdout, stderr, factory) = Setup();

            var code = await app.RunAsync(["--stats", log.LogFilePath], TextReader.Null, stdout, stderr, Tty, Tty);

            Assert.Equal(0, code);
            var text = stdout.ToString();
            Assert.Contains("回合数: 1", text);
            Assert.Contains("缓存命中 900", text);
            Assert.Contains("命中率 90.0%", text);
            Assert.Equal("", stderr.ToString());
            Assert.Equal(0, factory.Calls);   // 离线命令绝不构建宿主
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task Stats_MissingPath_ExitsOne_WithoutHost()
    {
        var (app, stdout, stderr, factory) = Setup();

        var code = await app.RunAsync(["--stats"], TextReader.Null, stdout, stderr, Tty, Tty);

        Assert.Equal(1, code);
        Assert.Contains("缺少值", stderr.ToString());
        Assert.Equal(0, factory.Calls);
    }

    [Fact]
    public async Task Stats_FileNotFound_ExitsOne_WithoutHost()
    {
        var (app, stdout, stderr, factory) = Setup();

        var code = await app.RunAsync(["--stats", "no-such-session.jsonl"], TextReader.Null, stdout, stderr, Tty, Tty);

        Assert.Equal(1, code);
        Assert.Contains("不存在", stderr.ToString());
        Assert.Equal(0, factory.Calls);
    }

    // ---- --skill-eval：用带标签用例集评估匹配器（依赖宿主） ----

    [Fact]
    public async Task SkillEval_WithCases_PrintsMetrics_ExitsZero()
    {
        var casesPath = WriteCases("""
            [
              { "message": "跑一下后端测试", "expected_skills": ["backend-tests"] },
              { "message": "随便聊聊", "expected_skills": [] }
            ]
            """);
        var skill = new Skill
        {
            Name = "backend-tests",
            Description = "运行并修复后端测试（dotnet）。当用户要求运行测试、分析失败或修复测试时使用。",
            Instructions = "1. dotnet build\n2. dotnet test",
        };
        var bus = new InMemoryEventBus();
        var host = new CliHost(new FakeRunner { Bus = bus }, bus, new FakeLlm([]), [skill], new ReplOptions(), null);
        var (app, stdout, stderr, factory) = Setup(host);

        var code = await app.RunAsync(["--skill-eval", casesPath], TextReader.Null, stdout, stderr, Tty, Tty);

        Assert.Equal(0, code);
        var text = stdout.ToString();
        Assert.Contains("用例数: 2", text);
        Assert.Contains("精确率: 1.000", text);
        Assert.Contains("召回率: 1.000", text);
        Assert.Contains("平均上下文 token/回合", text);
        Assert.Equal("", stderr.ToString());
        Assert.Equal(1, factory.Calls);   // skill-eval 复用宿主的 skill 发现结果
    }

    [Fact]
    public async Task SkillEval_MissingPath_ExitsOne_WithoutHost()
    {
        var (app, stdout, stderr, factory) = Setup();

        var code = await app.RunAsync(["--skill-eval"], TextReader.Null, stdout, stderr, Tty, Tty);

        Assert.Equal(1, code);
        Assert.Contains("缺少值", stderr.ToString());
        Assert.Equal(0, factory.Calls);
    }

    [Fact]
    public async Task SkillEval_NoCasesFile_ExitsOne()
    {
        var (app, stdout, stderr, factory) = Setup(Host([]));

        var code = await app.RunAsync(["--skill-eval", "no-such-cases.json"], TextReader.Null, stdout, stderr, Tty, Tty);

        Assert.Equal(1, code);
        Assert.Contains("无法加载用例文件", stderr.ToString());
    }

    private static string WriteCases(string content)
    {
        var path = Path.Combine(Path.GetTempPath(), "di-eval-cases-" + Guid.NewGuid().ToString("N") + ".json");
        File.WriteAllText(path, content);
        return path;
    }

    [Fact]
    public async Task Interactive_ReadsStdin_RunsAgentTurn()
    {
        var bus = new InMemoryEventBus();
        var runner = new FakeRunner { Bus = bus };
        var host = new CliHost(runner, bus, new FakeLlm([]), [], new ReplOptions(), null);
        var (app, stdout, stderr, factory) = Setup(host);
        var stdin = new StringReader("你好\n/exit\n");

        var code = await app.RunAsync([], stdin, stdout, stderr, Tty, Tty);

        Assert.Equal(0, code);
        Assert.Equal(["你好"], runner.Messages);
        Assert.Contains("di>", stdout.ToString());
        Assert.Contains("回答: 你好", stdout.ToString());
        Assert.Equal(1, factory.Calls);
    }

    [Fact]
    public async Task Interactive_StdinEof_ExitsZero_WithoutRunningTurn()
    {
        var bus = new InMemoryEventBus();
        var runner = new FakeRunner { Bus = bus };
        var host = new CliHost(runner, bus, new FakeLlm([]), [], new ReplOptions(), null);
        var (app, stdout, _, factory) = Setup(host);

        var code = await app.RunAsync([], TextReader.Null, stdout, new StringWriter(), Tty, Tty);

        Assert.Equal(0, code);
        Assert.Empty(runner.Messages);
        Assert.Contains("di>", stdout.ToString());
    }

    // ---- 工具 ----

    private static CliHost Host(IReadOnlyList<LlmModelInfo> models)
    {
        var bus = new InMemoryEventBus();
        return new CliHost(new FakeRunner { Bus = bus }, bus, new FakeLlm(models), [], new ReplOptions(), null);
    }

    /// <summary>记录宿主构建次数；未提供 fake 宿主时抛错（证明该路径不应构建）。</summary>
    private sealed class HostFactory
    {
        private readonly CliHost? _host;
        public HostFactory(CliHost? host = null) => _host = host;
        public int Calls { get; private set; }

        public CliHost Create(CliArgs args, string workspace, TextWriter stderr, bool useAnsi)
        {
            Calls++;
            return _host ?? throw new InvalidOperationException("该路径不应构建宿主");
        }
    }
}
