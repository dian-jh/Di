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

    private static string Args(string command, string? workingDir = null, int? timeout = null)
    {
        var parts = new List<string> { $"\"command\":{JsonQuote(command)}" };
        if (workingDir is not null)
            parts.Add($"\"working_dir\":{JsonQuote(workingDir)}");
        if (timeout is not null)
            parts.Add($"\"timeout\":{timeout}");
        return "{" + string.Join(",", parts) + "}";
    }

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

    // ---- per-call timeout 参数（对齐生产级：模型可对单条命令覆盖默认超时）----

    [Fact]
    public async Task Execute_TimeoutArg_OverridesDefaultAndTimesOut()
    {
        // 工具默认 5 秒本不会触发；per-call timeout=1 秒必须生效 → 约 1 秒内返回 error。
        var tool = new BashTool(_base, timeout: TimeSpan.FromSeconds(5));
        var sleep = OperatingSystem.IsWindows() ? "for /l %i in (1,1,100000000) do @rem" : "sleep 60";

        var result = await tool.ExecuteAsync(Args(sleep, timeout: 1));

        Assert.StartsWith("error:", result);
        Assert.Contains("秒", result);
    }

    [Fact]
    public async Task Execute_TimeoutArg_LongerThanDefault_Completes()
    {
        // 工具默认 300ms 会误杀一条 ~1 秒的命令；per-call timeout=2 秒覆盖后应正常完成。
        var tool = new BashTool(_base, timeout: TimeSpan.FromMilliseconds(300));
        var shortCmd = OperatingSystem.IsWindows() ? "ping -n 2 127.0.0.1 >nul" : "sleep 1";

        var result = await tool.ExecuteAsync(Args(shortCmd, timeout: 2));

        Assert.StartsWith("exit: 0", result);
    }

    [Fact]
    public async Task Execute_InvalidTimeoutArg_ReturnsError()
    {
        var tool = new BashTool(_base);

        Assert.Contains("timeout", await tool.ExecuteAsync(Args("echo x", timeout: 0)));
        Assert.Contains("timeout", await tool.ExecuteAsync(Args("echo x", timeout: -3)));
        Assert.Contains("timeout", await tool.ExecuteAsync(Args("echo x", timeout: 99999)));   // 超过上限 3600
        var nonInteger = await tool.ExecuteAsync("""{"command":"echo x","timeout":"abc"}""");
        Assert.Contains("timeout", nonInteger);
    }

    [Fact]
    public async Task Execute_WithSession_TimeoutArg_OverridesDefault()
    {
        using var session = new ShellSession(_base);
        var tool = new BashTool(_base, session: session, timeout: TimeSpan.FromMilliseconds(300));
        var shortCmd = OperatingSystem.IsWindows() ? "ping -n 2 127.0.0.1 >nul" : "sleep 1";

        var result = await tool.ExecuteAsync(Args(shortCmd, timeout: 3));

        Assert.StartsWith("exit: 0", result);   // 覆盖默认 300ms 后未被误杀
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
        // 输出超过截断预算（头 6000 + 尾 18000 字符）→ 保留头尾、标记截断、整体受预算约束。
        // Windows 用 for 循环避免单条命令超长；Unix 用 head/tr 生成一条超长行。
        var big = OperatingSystem.IsWindows()
            ? "for /l %i in (1,1,500) do @echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            : "head -c 30000 < /dev/zero | tr '\\0' x";
        var result = await new BashTool(_base).ExecuteAsync(Args(big));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("已截断", result);
        Assert.True(result.Length < 30000, $"截断后应受预算约束（头+尾+标记），实际 {result.Length} 字符");
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
        Assert.Equal(CoreTools.PlatformShellName, def.Name);   // Windows 为 "cmd"，其他平台为 "bash"
        Assert.True(def.Parameters["properties"]!["command"] is not null);
    }

    // ---- 悲观：引号/特殊字符/工作目录 ----

    [Fact]
    public async Task Execute_CommandWithDoubleQuotes_NoBackslashCorruption()
    {
        // Windows 上 cmd.exe 必须手工构造 /d /s /c "命令"；ArgumentList 的 \" 转义
        // cmd 不认，会把反斜杠原样输出（bug：echo "hi" → \"hi\"）。任何平台都不允许 \" 污染。
        var result = await new BashTool(_base).ExecuteAsync(Args("echo \"hello world\""));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("hello world", result);
        Assert.DoesNotContain("\\\"", result);
    }

    [Fact]
    public async Task Execute_CommandWithNestedQuotes_PreservesMeaning()
    {
        if (!OperatingSystem.IsWindows())
            return;   // sh 会剥掉双引号，语义不同；这里只验证 Windows cmd。

        var result = await new BashTool(_base).ExecuteAsync(Args("echo it's \"a b\" here"));

        Assert.Contains("it's", result);
        Assert.Contains("\"a b\"", result);   // cmd 保留内层引号
        Assert.DoesNotContain("\\", result);
    }

    [Fact]
    public async Task Execute_CommandWithAmpersand_RunsBothCommands()
    {
        var result = await new BashTool(_base).ExecuteAsync(Args("echo first & echo second"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("first", result);
        Assert.Contains("second", result);
    }

    [Fact]
    public async Task Execute_CommandWithRedirection_WritesFileInWorkingDir()
    {
        var result = await new BashTool(_base).ExecuteAsync(Args("echo marker > bash-marker.txt"));

        Assert.StartsWith("exit: 0", result);
        var path = Path.Combine(_base, "bash-marker.txt");
        Assert.True(File.Exists(path), $"期望文件 {path} 被创建");
        Assert.Contains("marker", File.ReadAllText(path));
    }

    [Fact]
    public async Task Execute_CommandWithEnvVarExpansion_Works()
    {
        if (!OperatingSystem.IsWindows())
            return;   // sh 的变量语法不同（$PWD），只验证 cmd 的 %CD%。

        var result = await new BashTool(_base).ExecuteAsync(Args("echo %CD%"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains(_base, result);   // %CD% 应展开为当前工作目录
    }

    [Fact]
    public async Task Execute_EmptyCommand_ReturnsError()
    {
        var result = await new BashTool(_base).ExecuteAsync("""{"command":""}""");

        Assert.StartsWith("error:", result);
        Assert.Contains("command", result);
    }

    [Fact]
    public async Task Execute_WorkingDirWithIllegalChar_ReturnsError()
    {
        var result = await new BashTool(_base).ExecuteAsync("""{"command":"echo x","working_dir":"bad\u0000dir"}""");

        Assert.StartsWith("error:", result);   // 不应抛 ArgumentException
    }

    // ---- 悲观：持久化终端会话模式 ----

    [Fact]
    public async Task Execute_WithSession_StatePersistsAcrossCalls()
    {
        Directory.CreateDirectory(Path.Combine(_base, "work"));
        using var session = new ShellSession(_base);
        var tool = new BashTool(_base, session: session);

        await tool.ExecuteAsync(Args("cd work"));
        var result = await tool.ExecuteAsync(Args(OperatingSystem.IsWindows() ? "cd" : "pwd"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("work", result);   // 第一次 cd 的状态在第二次调用中仍然有效
    }

    [Fact]
    public async Task Execute_WithSession_WorkingDirParamIsIgnored()
    {
        // 会话模式下 working_dir 不在 schema 中；模型即使传了也不影响会话状态（cd 才是正路）。
        using var session = new ShellSession(_base);
        var tool = new BashTool(_base, session: session);

        var set = OperatingSystem.IsWindows() ? "set DI_T=yes" : "export DI_T=yes";
        var read = OperatingSystem.IsWindows() ? "echo %DI_T%" : "echo $DI_T";
        await tool.ExecuteAsync(Args(set, "sub/that/does/not/exist"));
        var result = await tool.ExecuteAsync(Args(read, "sub/that/does/not/exist"));

        Assert.Contains("yes", result);
    }

    [Fact]
    public void Definition_WithSession_OmitsWorkingDirAndDescribesPersistence()
    {
        using var session = new ShellSession(_base);
        var def = new BashTool(_base, session: session).Definition;

        Assert.Equal(CoreTools.PlatformShellName, def.Name);   // Windows 为 "cmd"，其他平台为 "bash"
        Assert.NotNull(def.Parameters["properties"]!["command"]);
        Assert.False(def.Parameters["properties"]!.AsObject().ContainsKey("working_dir"));
        Assert.Contains("持久化", def.Description);
    }

    [Fact]
    public async Task Execute_WithSession_TimeoutSelfHeals()
    {
        using var session = new ShellSession(_base);
        var tool = new BashTool(_base, session: session, timeout: TimeSpan.FromMilliseconds(300));

        var timedOut = await tool.ExecuteAsync(Args(
            OperatingSystem.IsWindows() ? "for /l %i in (1,1,100000000) do @rem" : "sleep 60"));
        Assert.StartsWith("error:", timedOut);
        Assert.Contains("秒", timedOut);

        var after = await tool.ExecuteAsync(Args("echo recovered"));
        Assert.StartsWith("exit: 0", after);
        Assert.Contains("recovered", after);
    }
}
