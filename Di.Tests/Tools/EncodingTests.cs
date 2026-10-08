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
}
