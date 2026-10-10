using Common.Events;
using Core.AgentLoop;
using Core.Llm;
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
    public async Task RpcMode_NotImplemented_ExitsOne_WithoutBuildingHost()
    {
        var (app, stdout, stderr, factory) = Setup();

        var code = await app.RunAsync(["--mode", "rpc"], TextReader.Null, stdout, stderr, Tty, Tty);

        Assert.Equal(1, code);
        Assert.Contains("尚未实现", stderr.ToString());
        Assert.Equal(0, factory.Calls);
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
