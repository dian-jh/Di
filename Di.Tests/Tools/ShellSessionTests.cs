using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 针对 <see cref="ShellSession"/>（持久化终端会话）的测试。
/// 覆盖：状态持久化（cwd/环境变量）、退出码、无换行输出、多行输出、超时自愈、exit 自愈、
/// 初始化排空、初始工作目录、长输出截断、释放。
/// 注意：session 进程在临时目录中运行，跨平台（Windows cmd / Unix sh）。
/// </summary>
public sealed class ShellSessionTests : IDisposable
{
    private readonly string _base = Directory.CreateTempSubdirectory("di-session-").FullName;
    private readonly string _sub;

    public ShellSessionTests()
    {
        _sub = Path.Combine(_base, "work");
        Directory.CreateDirectory(_sub);
        Directory.CreateDirectory(Path.Combine(_base, "other"));
    }

    public void Dispose()
    {
        try { Directory.Delete(_base, recursive: true); } catch { }
    }

    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    private static string Cd() => OperatingSystem.IsWindows() ? "cd" : "pwd";
    private static string LongSleep() => OperatingSystem.IsWindows()
        ? "for /l %i in (1,1,100000000) do @rem"
        : "sleep 60";
    private static string NoTrailingNewlineOutput() => OperatingSystem.IsWindows()
        ? "<nul set /p=x"
        : "printf x";

    // ---- 基本执行 ----

    [Fact]
    public async Task Execute_SimpleCommand_ReturnsOutputAndExitZero()
    {
        using var session = new ShellSession(_base);
        var result = await session.ExecuteAsync("echo hello", Timeout);

        Assert.StartsWith("exit: 0", result.ToObservation());
        Assert.Contains("hello", result.ToObservation());
    }

    [Fact]
    public async Task Execute_InitialWorkingDirectory_IsUsed()
    {
        using var session = new ShellSession(_sub);
        var result = await session.ExecuteAsync(Cd(), Timeout);

        Assert.Contains("work", result.ToObservation());
    }

    [Fact]
    public async Task Execute_NonZeroExit_IsReported()
    {
        using var session = new ShellSession(_base);
        var command = OperatingSystem.IsWindows() ? "cmd /c exit 3" : "false";
        var expected = OperatingSystem.IsWindows() ? "exit: 3" : "exit: 1";
        var result = await session.ExecuteAsync(command, Timeout);

        Assert.StartsWith(expected, result.ToObservation());
    }

    // ---- 状态持久化（第五章核心） ----

    [Fact]
    public async Task Execute_Cwd_PersistsAcrossCommands()
    {
        using var session = new ShellSession(_base);
        await session.ExecuteAsync("cd work", Timeout);

        var result = await session.ExecuteAsync(Cd(), Timeout);

        Assert.Contains("work", result.ToObservation());
    }

    [Fact]
    public async Task Execute_EnvironmentVariable_PersistsAcrossCommands()
    {
        using var session = new ShellSession(_base);
        var set = OperatingSystem.IsWindows() ? "set DI_VAR=abc" : "export DI_VAR=abc";
        var read = OperatingSystem.IsWindows() ? "echo %DI_VAR%" : "echo $DI_VAR";
        await session.ExecuteAsync(set, Timeout);

        var result = await session.ExecuteAsync(read, Timeout);

        Assert.Contains("abc", result.ToObservation());
    }

    [Fact]
    public async Task Execute_SubsequentCd_OverridesPrevious()
    {
        using var session = new ShellSession(_base);
        await session.ExecuteAsync(CdCommand(Path.Combine(_base, "work")), Timeout);
        await session.ExecuteAsync(CdCommand(Path.Combine(_base, "other")), Timeout);

        var result = await session.ExecuteAsync(Cd(), Timeout);

        Assert.Contains("other", result.ToObservation());
        Assert.DoesNotContain("work", result.ToObservation());
    }

    private static string CdCommand(string dir) => OperatingSystem.IsWindows()
        ? $"cd /d \"{dir}\""
        : $"cd '{dir}'";

    // ---- 输出边界 ----

    [Fact]
    public async Task Execute_MultilineOutput_CollectedInOrder()
    {
        using var session = new ShellSession(_base);
        var result = await session.ExecuteAsync("echo one & echo two & echo three", Timeout);

        var obs = result.ToObservation();
        var i1 = obs.IndexOf("one", StringComparison.Ordinal);
        var i2 = obs.IndexOf("two", StringComparison.Ordinal);
        var i3 = obs.IndexOf("three", StringComparison.Ordinal);
        Assert.True(i1 >= 0 && i2 > i1 && i3 > i2, $"输出顺序被打乱: {obs}");
    }

    [Fact]
    public async Task Execute_OutputWithoutTrailingNewline_DoesNotHang()
    {
        using var session = new ShellSession(_base);
        // 命令输出不带末尾换行，紧接着的标记行会被拼到同一行——也必须正确识别边界。
        var result = await session.ExecuteAsync(NoTrailingNewlineOutput(), Timeout);

        Assert.StartsWith("exit:", result.ToObservation());
        Assert.Contains("x", result.ToObservation());
    }

    [Fact]
    public async Task Execute_EmptyCommand_StillReturnsMarker()
    {
        using var session = new ShellSession(_base);
        var result = await session.ExecuteAsync("", Timeout);

        Assert.StartsWith("exit: 0", result.ToObservation());
    }

    // ---- 失败/自愈 ----

    [Fact]
    public async Task Execute_Timeout_KillsSession_AndSelfHeals()
    {
        using var session = new ShellSession(_base);
        var result = await session.ExecuteAsync(LongSleep(), TimeSpan.FromMilliseconds(300));

        Assert.StartsWith("error:", result.ToObservation());
        Assert.Contains("秒", result.ToObservation());

        var after = await session.ExecuteAsync("echo after-timeout", Timeout);

        Assert.StartsWith("exit: 0", after.ToObservation());
        Assert.Contains("after-timeout", after.ToObservation());
    }

    [Fact]
    public async Task Execute_ExitCommand_EndsSession_AndNextCallRespawns()
    {
        using var session = new ShellSession(_base);
        await session.ExecuteAsync("exit 0", Timeout);

        var after = await session.ExecuteAsync("echo after-exit", Timeout);

        Assert.StartsWith("exit: 0", after.ToObservation());
        Assert.Contains("after-exit", after.ToObservation());
    }

    // ---- 边界 ----

    [Fact]
    public async Task Execute_LongOutput_IsTruncated()
    {
        using var session = new ShellSession(_base);
        var big = OperatingSystem.IsWindows()
            ? "echo " + new string('a', 4000)
            : "head -c 5000 < /dev/zero | tr '\\0' x";
        var result = await session.ExecuteAsync(big, Timeout);

        Assert.StartsWith("exit: 0", result.ToObservation());
        Assert.Contains("已截断", result.ToObservation());
        Assert.True(result.ToObservation().Length < 5000);
    }

    [Fact]
    public void Dispose_KillsProcess()
    {
        var session = new ShellSession(_base);
        _ = session.ExecuteAsync("echo hi", Timeout).GetAwaiter().GetResult();
        Assert.True(session.IsAlive);

        session.Dispose();

        Assert.False(session.IsAlive);
    }
}
