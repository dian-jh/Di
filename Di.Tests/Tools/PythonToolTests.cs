using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 针对 <see cref="PythonTool"/>（Code Interpreter）的悲观测试。
/// 覆盖：执行输出、stderr、工作目录、默认沙盒（临时目录）、超时、缺解释器、参数/JSON/路径错误、
/// 中文输出、含引号代码、多行缩进、沙盒内写文件、非零退出码。
/// 逻辑用例统一用 TestEnvironment.FindPython() 找到的解释器（testhost PATH 不含 python 时也能真跑）。
/// </summary>
public sealed class PythonToolTests : IDisposable
{
    private static readonly string? PythonExe = TestEnvironment.FindPython();
    private static readonly bool Py = PythonExe is not null;

    private readonly string _base = Directory.CreateTempSubdirectory("di-py-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_base, recursive: true); } catch { }
    }

    private PythonTool NewTool(TimeSpan? timeout = null)
    {
        Assert.True(Py, "测试环境找不到可用的 python，无法执行依赖 python 的用例");
        return new PythonTool(PythonExe!, timeout: timeout);
    }

    private static string Args(string code, string? workingDir = null)
        => workingDir is null
            ? $$"""{"code":{{JsonQuote(code)}}}"""
            : $$"""{"code":{{JsonQuote(code)}},"working_dir":{{JsonQuote(workingDir)}}}""";

    private static string JsonQuote(string s) => System.Text.Json.JsonSerializer.Serialize(s);

    // ---- 正常路径 ----

    [Fact]
    public async Task Execute_RunsCodeAndReturnsStdout()
    {
        if (!Py) return;
        var result = await NewTool().ExecuteAsync(Args("print(6 * 7)"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("42", result);
    }

    [Fact]
    public async Task Execute_RaisesException_ReturnsNonZeroExitAndTraceback()
    {
        if (!Py) return;
        var result = await NewTool().ExecuteAsync(Args("raise ValueError('boom')"));

        Assert.StartsWith("exit: 1", result);
        Assert.Contains("Traceback", result);   // stderr 并入输出
        Assert.Contains("boom", result);
    }

    [Fact]
    public async Task Execute_WorkingDirectory_IsHonored()
    {
        if (!Py) return;
        var sub = Path.Combine(_base, "work");
        Directory.CreateDirectory(sub);
        var result = await NewTool().ExecuteAsync(Args("import os; print(os.getcwd())", sub));

        Assert.Contains("work", result);
    }

    [Fact]
    public async Task Execute_DefaultWorkingDirectory_IsTempSandbox()
    {
        if (!Py) return;
        // 第五章：代码解释器在隔离沙盒中运行（进程级隔离；MVP 默认工作目录=临时目录）。
        var result = await NewTool().ExecuteAsync(Args("import os; print(os.getcwd())"));

        Assert.Contains("Temp", result);
    }

    [Fact]
    public async Task Execute_MultilineCode_RunsCorrectly()
    {
        if (!Py) return;
        var result = await NewTool().ExecuteAsync(Args("x = 0\nfor i in range(5):\n    x += i\nprint(x)"));

        Assert.Contains("10", result);
    }

    [Fact]
    public async Task Execute_CodeContainingQuotes_Runs()
    {
        if (!Py) return;
        // 单引号与双引号都要原样到达 python（经过 ProcessRunner 的参数转义仍正确）。
        var result = await NewTool().ExecuteAsync(Args("print('it\\'s', \"a\\\"b\\\"\")"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("it's", result);
        Assert.Contains("a\"b\"", result);
    }

    [Fact]
    public async Task Execute_ChinesePrintOutput_RoundTrips()
    {
        if (!Py) return;
        var result = await NewTool().ExecuteAsync(Args("print('你好世界')"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("你好世界", result);   // 编码不能出乱码
    }

    [Fact]
    public async Task Execute_CodeWritingFile_InSandboxWorks()
    {
        if (!Py) return;
        // 代码在沙盒临时目录里跑，能读写它自己的工作区文件。
        var result = await NewTool().ExecuteAsync(Args("with open('made.py', 'w') as f: f.write('ok')\nprint('written')"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("written", result);
    }

    [Fact]
    public async Task Execute_UnicodeComputation_Works()
    {
        if (!Py) return;
        var result = await NewTool().ExecuteAsync(Args("print(len('héllo wörld'))"));

        Assert.Contains("11", result);
    }

    [Fact]
    public async Task Execute_SystemExit_ReportsExitCode()
    {
        if (!Py) return;
        var result = await NewTool().ExecuteAsync(Args("import sys; sys.exit(7)"));

        Assert.StartsWith("exit: 7", result);
    }

    // ---- 失败路径 ----

    [Fact]
    public async Task Execute_Timeout_ReturnsStructuredError()
    {
        if (!Py) return;
        var result = await NewTool(timeout: TimeSpan.FromMilliseconds(300))
            .ExecuteAsync(Args("import time; time.sleep(60)"));

        Assert.StartsWith("error:", result);
        Assert.Contains("秒", result);
    }

    [Fact]
    public async Task Execute_MissingCodeArgument_ReturnsError()
    {
        var result = await new PythonTool().ExecuteAsync("""{}""");

        Assert.StartsWith("error:", result);
        Assert.Contains("code", result);
    }

    [Fact]
    public async Task Execute_NonexistentWorkingDirectory_ReturnsError()
    {
        if (!Py) return;
        var result = await NewTool().ExecuteAsync(Args("print(1)", "no/such/dir"));

        Assert.StartsWith("error:", result);
        Assert.Contains("目录不存在", result);
    }

    [Fact]
    public async Task Execute_WorkingDirectoryWithIllegalChar_ReturnsError()
    {
        if (!Py) return;
        var result = await NewTool().ExecuteAsync(Args("print(1)", "bad\0dir"));

        Assert.StartsWith("error:", result);   // 不应抛 ArgumentException
    }

    [Fact]
    public async Task Execute_InvalidJson_ReturnsError()
    {
        var result = await new PythonTool().ExecuteAsync("nope");

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public async Task Execute_PythonNotInstalled_ReturnsError()
    {
        var result = await new PythonTool("definitely_not_a_real_python_xyz").ExecuteAsync(Args("print(1)"));

        Assert.StartsWith("error:", result);
        Assert.Contains("无法启动", result);
    }

    [Fact]
    public void Execute_CancelledToken_IsNotTreatedAsToolFailure()
    {
        // 悲观：外部取消应让调用方收到取消，而不是返回一个 error 观察。
        if (!Py) return;
        using var cts = new CancellationTokenSource(150);
        // TaskCanceledException 是 OperationCanceledException 的子类，用 ThrowsAnyAsync。
        Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => new PythonTool(PythonExe!).ExecuteAsync(Args("import time; time.sleep(60)"), cts.Token)).GetAwaiter().GetResult();
    }

    [Fact]
    public void Definition_HasNameAndSchema()
    {
        var def = new PythonTool().Definition;
        Assert.Equal("python", def.Name);
        Assert.True(def.Parameters["properties"]!["code"] is not null);
    }
}
