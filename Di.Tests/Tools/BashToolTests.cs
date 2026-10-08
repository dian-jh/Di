using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 针对 <see cref="BashTool"/> 的单元测试（真实子进程，跨平台）。
/// 覆盖：输出捕获、退出码、stderr 合并、超时终止、工作目录、坏 shell、参数/JSON 错误、长输出截断。
/// </summary>
public sealed class BashToolTests : IDisposable
{
    private readonly string _base = Directory.CreateTempSubdirectory("di-bash-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_base, recursive: true); } catch { }
    }

    private static string Args(string command, string? workingDir = null)
        => workingDir is null
            ? $$"""{"command":{{JsonQuote(command)}}}"""
            : $$"""{"command":{{JsonQuote(command)}},"working_dir":{{JsonQuote(workingDir)}}}""";

    private static string JsonQuote(string s) => System.Text.Json.JsonSerializer.Serialize(s);

    // ---- 正常路径 ----

    [Fact]
    public async Task Execute_EchoCommand_ReturnsOutputAndExitZero()
    {
        var result = await new BashTool(_base).ExecuteAsync(Args("echo hello"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("hello", result);
    }

    [Fact]
    public async Task Execute_NonZeroExitCode_IsReportedNotError()
    {
        // "exit 3" 在 cmd 与 sh 下语义一致。
        var result = await new BashTool(_base).ExecuteAsync(Args("exit 3"));

        Assert.StartsWith("exit: 3", result);
        Assert.False(result.StartsWith("error:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Execute_UnknownCommand_ReturnsNonZeroExitNotError()
    {
        var result = await new BashTool(_base).ExecuteAsync(Args("definitely_not_a_real_command_xyz"));

        Assert.StartsWith("exit:", result);   // shell 报"命令不存在"并给非零退出码，属于正常观察
        Assert.False(result.StartsWith("error:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Execute_Stderr_IsMergedIntoOutput()
    {
        var result = await new BashTool(_base).ExecuteAsync(Args("echo oops 1>&2"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("oops", result);
    }

    [Fact]
    public async Task Execute_WorkingDirectory_Honored()
    {
        var sub = Path.Combine(_base, "sub");
        Directory.CreateDirectory(sub);
        File.WriteAllText(Path.Combine(sub, "hello.txt"), "from-subdir");

        var result = await new BashTool(_base).ExecuteAsync(
            Args(OperatingSystem.IsWindows() ? "type hello.txt" : "cat hello.txt", "sub"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("from-subdir", result);
    }

    [Fact]
    public async Task Execute_RelativeWorkingDirectory_ResolvesAgainstBase()
    {
        Directory.CreateDirectory(Path.Combine(_base, "w"));
        File.WriteAllText(Path.Combine(_base, "w", "f.txt"), "rel-works");

        var result = await new BashTool(_base).ExecuteAsync(
            Args(OperatingSystem.IsWindows() ? "type f.txt" : "cat f.txt", "w"));

        Assert.Contains("rel-works", result);
    }

    // ---- 失败路径 ----

    [Fact]
    public async Task Execute_Timeout_ReturnsStructuredError()
    {
        // 只用 shell 内建命令（for / rem / sleep），避免依赖外部命令的 PATH。
        var sleep = OperatingSystem.IsWindows() ? "for /l %i in (1,1,100000000) do @rem" : "sleep 60";
        var result = await new BashTool(_base, timeout: TimeSpan.FromMilliseconds(300)).ExecuteAsync(Args(sleep));

        Assert.StartsWith("error:", result);
        Assert.Contains("秒", result);   // 第五章：超时返回结构化错误而非静默杀死
    }

    [Fact]
    public async Task Execute_NonexistentWorkingDirectory_ReturnsError()
    {
        var result = await new BashTool(_base).ExecuteAsync(Args("echo x", "no/such/dir"));

        Assert.StartsWith("error:", result);
        Assert.Contains("目录不存在", result);
    }

    [Fact]
    public async Task Execute_MissingCommandArgument_ReturnsError()
    {
        var result = await new BashTool(_base).ExecuteAsync("""{}""");

        Assert.StartsWith("error:", result);
        Assert.Contains("command", result);
    }

    [Fact]
    public async Task Execute_InvalidJson_ReturnsError()
    {
        var result = await new BashTool(_base).ExecuteAsync("nope");

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public async Task Execute_NonexistentShellExecutable_ReturnsError()
    {
        var tool = new BashTool(_base, shell: new ShellCommand("definitely_not_a_real_exe_xyz", []));
        var result = await tool.ExecuteAsync(Args("echo x"));

        Assert.StartsWith("error:", result);
        Assert.Contains("无法启动", result);
    }

    // ---- 边界 ----

    [Fact]
    public async Task Execute_LongOutput_IsTruncatedWithMarker()
    {
        // echo 是内建命令：单行 4000 字符超过截断阈值，不依赖外部命令。
        var big = OperatingSystem.IsWindows()
            ? "echo " + new string('a', 4000)
            : "head -c 5000 < /dev/zero | tr '\\0' x";
        var result = await new BashTool(_base).ExecuteAsync(Args(big));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("已截断", result);
        Assert.True(result.Length < 5000, $"截断后应显著小于原始输出，实际 {result.Length} 字符");
    }

    [Fact]
    public async Task Execute_EmptyCommandOutput_IsCleanObservation()
    {
        var result = await new BashTool(_base).ExecuteAsync(Args(OperatingSystem.IsWindows() ? "cd" : "true"));

        Assert.StartsWith("exit: 0", result);
    }

    [Fact]
    public void Definition_HasNameAndSchema()
    {
        var def = new BashTool(_base).Definition;
        Assert.Equal("bash", def.Name);
        Assert.True(def.Parameters["properties"]!["command"] is not null);
    }
}
