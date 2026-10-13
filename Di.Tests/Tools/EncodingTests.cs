using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>编码回归测试串行执行，避免并行测试互相改写 Console.OutputEncoding 全局状态。</summary>
[CollectionDefinition("ConsoleEncoding", DisableParallelization = true)]
public sealed class ConsoleEncodingCollection;

/// <summary>
/// 编码回归测试：复现真实 CLI 的控制台条件（.NET 启动时把 Console.OutputEncoding 设为 UTF-8），
/// 验证 cmd.exe / python 写入的 OEM 代码页（中文系统 = GBK/936）字节被正确解码，不再出现乱码。
/// 根因与修复见 Core/Tools/ProcessEncoding.cs。
/// </summary>
[Collection("ConsoleEncoding")]
public sealed class EncodingTests : IDisposable
{
    private static readonly string? PythonExe = TestEnvironment.FindPython();

    private readonly string _base = Directory.CreateTempSubdirectory("di-enc-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_base, recursive: true); } catch { }
    }

    private static string Args(string command) => $$"""{"command":{{System.Text.Json.JsonSerializer.Serialize(command)}}}""";

    private static string PyArgs(string code) => $$"""{"code":{{System.Text.Json.JsonSerializer.Serialize(code)}}}""";

    /// <summary>在真实 CLI 的控制台状态下跑：Console.OutputEncoding = UTF-8，子进程却写 OEM 字节。</summary>
    private static async Task<T> WithUtf8Console<T>(Func<Task<T>> body)
    {
        var original = Console.OutputEncoding;
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        try { return await body().ConfigureAwait(false); }
        finally { Console.OutputEncoding = original; }
    }

    [Fact]
    public async Task Bash_OneShot_ChineseOutput_IsCorrect_UnderUtf8Console()
    {
        var result = await WithUtf8Console(() => new BashTool(_base).ExecuteAsync(Args("echo 你好世界")));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("你好世界", result);   // 修复前：� 乱码
    }

    [Fact]
    public async Task Bash_Session_ChineseOutput_IsCorrect_UnderUtf8Console()
    {
        using var session = new ShellSession(_base);
        var tool = new BashTool(_base, session: session);

        var result = await WithUtf8Console(() => tool.ExecuteAsync(Args("echo 你好世界")));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("你好世界", result);
    }

    [Fact]
    public async Task Bash_CmdErrorMessage_Chinese_IsCorrect_UnderUtf8Console()
    {
        // 用户现场那条：cmd 报"系统找不到指定的路径"——错误信息走 stderr，同样要正确解码。
        if (!OperatingSystem.IsWindows())
            return;
        var result = await WithUtf8Console(() =>
            new BashTool(_base).ExecuteAsync(Args("cd E:\\definitely\\no\\such\\dir 2>&1")));

        Assert.StartsWith("exit: 1", result);
        Assert.Contains("系统找不到指定的路径", result);
    }

    [Fact]
    public async Task Python_ChineseOutput_IsCorrect_UnderUtf8Console()
    {
        if (PythonExe is null) return;
        var result = await WithUtf8Console(() =>
            new PythonTool(PythonExe).ExecuteAsync(PyArgs("print('你好世界')")));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("你好世界", result);
    }

    // ---- SmartDecode 单元测试（2026-10-13 修复） ----

    [Fact]
    public void SmartDecode_Utf8Bytes_ReturnsUtf8()
    {
        // .NET CLI 的字节（重定向 stdout 时强制 UTF-8）必须按 UTF-8 解。
        var bytes = System.Text.Encoding.UTF8.GetBytes("你好世界");

        Assert.Equal("你好世界", ProcessEncoding.SmartDecode(bytes));
    }

    [Fact]
    public void SmartDecode_OemBytes_ReturnsOriginal()
    {
        // cmd 内建命令的字节（系统 OEM 代码页，中文系统 = GBK）。仅当字符串在该代码页可逆时断言。
        var s = "你好世界";
        var bytes = ProcessEncoding.ChildOutput.GetBytes(s);
        if (ProcessEncoding.ChildOutput.GetString(bytes) != s)
            return;   // 西文代码页无法编码中文，跳过

        Assert.Equal(s, ProcessEncoding.SmartDecode(bytes));
    }

    [Fact]
    public void SmartDecode_AsciiBytes_SameUnderBothEncodings()
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes("exit: 0 /d/s/c alpha-beta");

        Assert.Equal("exit: 0 /d/s/c alpha-beta", ProcessEncoding.SmartDecode(bytes));
    }

    [Fact]
    public void SmartDecode_EndsMidUtf8Char_TrimsFragmentInsteadOfOemFallback()
    {
        // 头段末尾被切断的多字节字符：整段严格 UTF-8 失败 → 修复前回退 OEM 整段乱码；
        // 修复后裁掉 1-3 字节残片仍按 UTF-8 解（代价：接缝处至多损失一个字符）。
        var full = System.Text.Encoding.UTF8.GetBytes("A好B");   // 41 E5 A5 BD 42
        var head = full.AsSpan(0, 3).ToArray();   // "A" + "好"的前 2 字节（E5 A5）

        Assert.Equal("A", ProcessEncoding.SmartDecode(head));
    }

    [Fact]
    public void SmartDecode_StartsMidUtf8Char_TrimsFragmentInsteadOfOemFallback()
    {
        var full = System.Text.Encoding.UTF8.GetBytes("A好B");   // 41 E5 A5 BD 42
        var tail = full.AsSpan(3).ToArray();   // "好"的最后 1 字节（BD）+ "B"

        Assert.Equal("B", ProcessEncoding.SmartDecode(tail));
    }

    // ---- ProcessRunner：字节级读取 + 末尾整段解码（问题 B） ----

    [Fact]
    public async Task ProcessRunner_Utf8Producer_IsDecoded()
    {
        // 模拟 .NET CLI：强制写 UTF-8 的生产者（python reconfigure），走 BashTool 同款
        // ProcessRunner（无 outputEncoding 覆盖 → SmartDecode）。修复前按 GBK 解 → 乱码。
        if (PythonExe is null) return;
        const string code = "import sys; sys.stdout.reconfigure(encoding='utf-8'); print('你好世界')";

        var result = await ProcessRunner.RunAsync(
            PythonExe, ["-c", code], _base, TimeSpan.FromSeconds(30), CancellationToken.None);

        Assert.Equal(0, result.ExitCode);
        Assert.Contains("你好世界", result.Output);
    }

    [Fact]
    public async Task ProcessRunner_OemProducer_IsDecoded()
    {
        // cmd 内建命令写 OEM 字节，SmartDecode 应回退到 OEM（回归保护：不能因引入 UTF-8 优先破坏 GBK）。
        if (!OperatingSystem.IsWindows()) return;

        var result = await ProcessRunner.RunAsync(
            "cmd.exe", ["/c", "echo 你好世界"], _base, TimeSpan.FromSeconds(10), CancellationToken.None);

        Assert.Contains("你好世界", result.Output);
    }

    [Fact]
    public async Task Bash_Session_MixedGbkAndUtf8_Producers_AreBothDecoded()
    {
        // 问题 B 的真实场景：同一会话里先跑 cmd 内建命令（GBK 字节），再跑强制 UTF-8 的生产者
        // （powershell 显式设 OutputEncoding=UTF8）。修复前固定按 GBK 流式解码 → UTF-8 那次乱码。
        // 修复后每段独立整段判定编码 → 两次都对。
        // 在真实 CLI 的 Console.InputEncoding=UTF8 条件下跑（Di.Cli/Program.cs 会设）——会话的
        // stdin 编码已钉死（cmd→OEM/GBK），不随 Console.InputEncoding 漂移，中文命令不被 cmd 误读。
        if (!OperatingSystem.IsWindows()) return;
        await WithUtf8InputConsole(async () =>
        {
            using var session = new ShellSession(_base);
            var tool = new BashTool(_base, session: session);

            var gbk = await tool.ExecuteAsync(Args("echo 你好世界"));
            Assert.Contains("你好世界", gbk);

            var utf8 = await tool.ExecuteAsync(Args(
                "powershell -NoProfile -Command \"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::WriteLine('你好世界')\""));
            Assert.Contains("你好世界", utf8);
            return true;
        });
    }

    /// <summary>在 Console.InputEncoding = UTF-8 的控制台条件下跑（对应真实 CLI 的 Program.cs 设置）。</summary>
    private static async Task<T> WithUtf8InputConsole<T>(Func<Task<T>> body)
    {
        var original = Console.InputEncoding;
        Console.InputEncoding = System.Text.Encoding.UTF8;
        try { return await body().ConfigureAwait(false); }
        finally { Console.InputEncoding = original; }
    }
}
