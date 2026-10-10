using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 针对 <see cref="PowerShellTool"/> 的单元测试（真实 powershell.exe 子进程，Windows）。
/// 覆盖：输出捕获、退出码、中文（UTF-8 输入/输出 + OEM 引擎错误）、超时、工作目录、
/// 一次性与持久化会话模式、参数/JSON 错误、长输出截断、CLIXML 不污染会话输出。
/// </summary>
public sealed class PowerShellToolTests : IDisposable
{
    private readonly string _base = Directory.CreateTempSubdirectory("di-ps-").FullName;

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

    // ---- 正常路径（一次性）----

    [Fact]
    public async Task Execute_WriteOutput_ReturnsOutputAndExitZero()
    {
        var result = await new PowerShellTool(_base).ExecuteAsync(Args("Write-Output hello"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("hello", result);
    }

    [Fact]
    public async Task Execute_NonZeroExitCode_IsReportedNotError()
    {
        // cmd /c exit 3 → 原生命令失败，$LASTEXITCODE=3 → 标记行把真实退出码带回来。
        var result = await new PowerShellTool(_base).ExecuteAsync(Args("cmd /c exit 3"));

        Assert.StartsWith("exit: 3", result);
        Assert.False(result.StartsWith("error:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Execute_UnknownCommand_ReturnsNonZeroExit_WithReadableError()
    {
        // 命令不存在 → $? 为 False → 兜底规则给 exit 1（对齐 cmd/bash 的"命令不存在"非零退出码）。
        // 引擎错误信息走 stderr（OEM 解码），中文错误文本应可读、不应出现 CLIXML XML。
        var result = await new PowerShellTool(_base).ExecuteAsync(Args("definitely_not_a_real_command_xyz"));

        Assert.StartsWith("exit: 1", result);
        Assert.Contains("definitely_not_a_real_command_xyz", result);   // 命令名保留
        Assert.DoesNotContain("CLIXML", result);   // 会话模式无 CLIXML 污染
    }

    [Fact]
    public async Task Execute_ChineseOutput_DecodedCorrectly()
    {
        // 中文命令经 stdin（UTF-8）进入、中文输出经 stdout（UTF-8）回传——两端都应无损。
        var result = await new PowerShellTool(_base).ExecuteAsync(Args("Write-Output \"你好世界\""));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("你好世界", result);
    }

    [Fact]
    public async Task Execute_WorkingDirectory_Honored()
    {
        var sub = Path.Combine(_base, "sub");
        Directory.CreateDirectory(sub);

        var result = await new PowerShellTool(_base).ExecuteAsync(Args("(Get-Location).Path", "sub"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("sub", result);
    }

    [Fact]
    public async Task Execute_RelativeWorkingDirectory_ResolvesAgainstBase()
    {
        Directory.CreateDirectory(Path.Combine(_base, "w"));

        var result = await new PowerShellTool(_base).ExecuteAsync(Args("(Get-Location).Path", "w"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("w", result);
    }

    // ---- 失败路径 ----

    [Fact]
    public async Task Execute_Timeout_ReturnsStructuredError()
    {
        var tool = new PowerShellTool(_base, timeout: TimeSpan.FromMilliseconds(300));

        var result = await tool.ExecuteAsync(Args("Start-Sleep -Seconds 5"));

        Assert.StartsWith("error:", result);
        Assert.Contains("秒", result);   // 超时返回结构化错误而非静默杀死
    }

    [Fact]
    public async Task Execute_TimeoutArg_OverridesDefaultAndTimesOut()
    {
        var tool = new PowerShellTool(_base, timeout: TimeSpan.FromSeconds(5));

        var result = await tool.ExecuteAsync(Args("Start-Sleep -Seconds 5", timeout: 1));

        Assert.StartsWith("error:", result);
        Assert.Contains("秒", result);
    }

    [Fact]
    public async Task Execute_TimeoutArg_LongerThanDefault_Completes()
    {
        var tool = new PowerShellTool(_base, timeout: TimeSpan.FromMilliseconds(300));

        var result = await tool.ExecuteAsync(Args("Start-Sleep -Milliseconds 300", timeout: 2));

        Assert.StartsWith("exit: 0", result);
    }

    [Fact]
    public async Task Execute_InvalidTimeoutArg_ReturnsError()
    {
        var tool = new PowerShellTool(_base);

        Assert.Contains("timeout", await tool.ExecuteAsync(Args("Write-Output x", timeout: 0)));
        Assert.Contains("timeout", await tool.ExecuteAsync(Args("Write-Output x", timeout: -3)));
        Assert.Contains("timeout", await tool.ExecuteAsync(Args("Write-Output x", timeout: 99999)));   // 超过上限 3600
        var nonInteger = await tool.ExecuteAsync("""{"command":"Write-Output x","timeout":"abc"}""");
        Assert.Contains("timeout", nonInteger);
    }

    [Fact]
    public async Task Execute_NonexistentWorkingDirectory_ReturnsError()
    {
        var result = await new PowerShellTool(_base).ExecuteAsync(Args("Write-Output x", "no/such/dir"));

        Assert.StartsWith("error:", result);
        Assert.Contains("目录不存在", result);
    }

    [Fact]
    public async Task Execute_MissingCommandArgument_ReturnsError()
    {
        var result = await new PowerShellTool(_base).ExecuteAsync("""{}""");

        Assert.StartsWith("error:", result);
        Assert.Contains("command", result);
    }

    [Fact]
    public async Task Execute_InvalidJson_ReturnsError()
    {
        var result = await new PowerShellTool(_base).ExecuteAsync("nope");

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public async Task Execute_NonexistentShellExecutable_ReturnsError()
    {
        using var session = new ShellSession(_base,
            new ShellCommand("definitely_not_a_real_exe_xyz", [], ShellSessionKind.PowerShell));
        var tool = new PowerShellTool(_base, session: session);

        var result = await tool.ExecuteAsync(Args("Write-Output x"));

        Assert.StartsWith("error:", result);
        Assert.Contains("无法启动", result);
    }

    // ---- 边界 ----

    [Fact]
    public async Task Execute_LongOutput_IsTruncatedWithMarker()
    {
        // 输出超过截断预算（头 6000 + 尾 18000 字符）→ 保留头尾、标记截断、整体受预算约束。
        var big = "1..500 | ForEach-Object { \"a\" * 60 }";
        var result = await new PowerShellTool(_base).ExecuteAsync(Args(big));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("已截断", result);
        Assert.True(result.Length < 30000, $"截断后应受预算约束（头+尾+标记），实际 {result.Length} 字符");
    }

    [Fact]
    public async Task Execute_EmptyCommandOutput_IsCleanObservation()
    {
        var result = await new PowerShellTool(_base).ExecuteAsync(Args("Write-Output $null"));

        Assert.StartsWith("exit: 0", result);
    }

    [Fact]
    public void Definition_HasNameAndSchema()
    {
        var def = new PowerShellTool(_base).Definition;

        Assert.Equal("powershell", def.Name);
        Assert.True(def.Parameters["properties"]!["command"] is not null);
    }

    // ---- 悲观：引号/特殊字符/工作目录 ----

    [Fact]
    public async Task Execute_CommandWithDoubleQuotes_NoBackslashCorruption()
    {
        // 会话经 stdin 传命令，不经命令行拼接——内嵌引号不应被反斜杠污染。
        var result = await new PowerShellTool(_base).ExecuteAsync(Args("Write-Output \"hello world\""));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("hello world", result);
        Assert.DoesNotContain("\\\"", result);
    }

    [Fact]
    public async Task Execute_CommandWithSemicolon_RunsBoth()
    {
        // PowerShell 用 ; 分隔多条语句（不是 cmd 的 &）。
        var result = await new PowerShellTool(_base).ExecuteAsync(Args("Write-Output 'first'; Write-Output 'second'"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("first", result);
        Assert.Contains("second", result);
    }

    [Fact]
    public async Task Execute_CommandWithRedirection_WritesFileInWorkingDir()
    {
        var result = await new PowerShellTool(_base).ExecuteAsync(
            Args("Set-Content -Path ps-marker.txt -Value 'marker'"));

        Assert.StartsWith("exit: 0", result);
        var path = Path.Combine(_base, "ps-marker.txt");
        Assert.True(File.Exists(path), $"期望文件 {path} 被创建");
        Assert.Contains("marker", File.ReadAllText(path));
    }

    [Fact]
    public async Task Execute_EmptyCommand_ReturnsError()
    {
        var result = await new PowerShellTool(_base).ExecuteAsync("""{"command":""}""");

        Assert.StartsWith("error:", result);
        Assert.Contains("command", result);
    }

    [Fact]
    public async Task Execute_WorkingDirWithIllegalChar_ReturnsError()
    {
        var result = await new PowerShellTool(_base).ExecuteAsync("""{"command":"Write-Output x","working_dir":"bad dir"}""");

        Assert.StartsWith("error:", result);   // 不应抛 ArgumentException
    }

    // ---- 悲观：持久化会话模式 ----

    [Fact]
    public async Task Execute_WithSession_StatePersistsAcrossCalls()
    {
        Directory.CreateDirectory(Path.Combine(_base, "work"));
        using var session = new ShellSession(_base, ShellCommand.PowerShellSession);
        var tool = new PowerShellTool(_base, session: session);

        await tool.ExecuteAsync(Args("cd work"));
        var result = await tool.ExecuteAsync(Args("(Get-Location).Path"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("work", result);   // 第一次 cd 的状态在第二次调用中仍然有效
    }

    [Fact]
    public async Task Execute_WithSession_WorkingDirParamIsIgnored()
    {
        // 会话模式下 working_dir 不在 schema 中；模型即使传了也不影响会话状态（cd 才是正路）。
        using var session = new ShellSession(_base, ShellCommand.PowerShellSession);
        var tool = new PowerShellTool(_base, session: session);

        await tool.ExecuteAsync(Args("$env:DI_T='yes'", "sub/that/does/not/exist"));
        var result = await tool.ExecuteAsync(Args("Write-Output $env:DI_T", "sub/that/does/not/exist"));

        Assert.Contains("yes", result);
    }

    [Fact]
    public void Definition_WithSession_OmitsWorkingDirAndDescribesPersistence()
    {
        using var session = new ShellSession(_base, ShellCommand.PowerShellSession);
        var def = new PowerShellTool(_base, session: session).Definition;

        Assert.Equal("powershell", def.Name);
        Assert.NotNull(def.Parameters["properties"]!["command"]);
        Assert.False(def.Parameters["properties"]!.AsObject().ContainsKey("working_dir"));
        Assert.Contains("持久化", def.Description);
    }

    [Fact]
    public async Task Execute_WithSession_TimeoutSelfHeals()
    {
        using var session = new ShellSession(_base, ShellCommand.PowerShellSession);
        var tool = new PowerShellTool(_base, session: session, timeout: TimeSpan.FromMilliseconds(300));

        var timedOut = await tool.ExecuteAsync(Args("Start-Sleep -Seconds 5"));
        Assert.StartsWith("error:", timedOut);
        Assert.Contains("秒", timedOut);

        var after = await tool.ExecuteAsync(Args("Write-Output recovered"));
        Assert.StartsWith("exit: 0", after);
        Assert.Contains("recovered", after);
    }

    [Fact]
    public async Task Execute_WithSession_UnknownCommand_ReturnsExitOne()
    {
        using var session = new ShellSession(_base, ShellCommand.PowerShellSession);
        var tool = new PowerShellTool(_base, session: session);

        var result = await tool.ExecuteAsync(Args("definitely_not_a_real_command_xyz"));

        Assert.StartsWith("exit: 1", result);   // 会话兜底规则：$? False → 至少 1
        Assert.False(result.StartsWith("error:", StringComparison.Ordinal));
    }
}
