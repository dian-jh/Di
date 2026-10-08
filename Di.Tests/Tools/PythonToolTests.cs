using System.Diagnostics;
using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 针对 <see cref="PythonTool"/>（Code Interpreter）的单元测试。
/// 覆盖：执行输出、错误+stderr、工作目录、默认沙盒目录（临时目录）、超时、缺解释器、参数/JSON 错误。
/// 依赖真实 python 的用例在环境没有 python 时跳过。
/// </summary>
public sealed class PythonToolTests : IDisposable
{
    private static readonly bool PythonAvailable = ProbePython();

    private readonly string _base = Directory.CreateTempSubdirectory("di-py-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_base, recursive: true); } catch { }
    }

    private static bool ProbePython()
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo("python", "--version")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });
            if (p is null)
                return false;
            p.WaitForExit(5000);
            return p.ExitCode == 0;
        }
        catch
        {
            return false;
        }
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
        if (!PythonAvailable) return;
        var result = await new PythonTool().ExecuteAsync(Args("print(6 * 7)"));

        Assert.StartsWith("exit: 0", result);
        Assert.Contains("42", result);
    }

    [Fact]
    public async Task Execute_RaisesException_ReturnsNonZeroExitAndTraceback()
    {
        if (!PythonAvailable) return;
        var result = await new PythonTool().ExecuteAsync(Args("raise ValueError('boom')"));

        Assert.StartsWith("exit: 1", result);
        Assert.Contains("Traceback", result);   // stderr 并入输出
        Assert.Contains("boom", result);
    }

    [Fact]
    public async Task Execute_WorkingDirectory_IsHonored()
    {
        if (!PythonAvailable) return;
        var sub = Path.Combine(_base, "work");
        Directory.CreateDirectory(sub);
        var result = await new PythonTool().ExecuteAsync(
            Args("import os; print(os.getcwd())", sub));

        Assert.Contains("work", result);
    }

    [Fact]
    public async Task Execute_DefaultWorkingDirectory_IsTempSandbox()
    {
        if (!PythonAvailable) return;
        // 第五章：代码解释器在隔离的沙盒环境中运行（进程隔离；MVP 默认工作目录=临时目录）。
        var result = await new PythonTool().ExecuteAsync(Args("import os; print(os.getcwd())"));

        Assert.Contains("Temp", result);
    }

    [Fact]
    public async Task Execute_MultilineCode_RunsCorrectly()
    {
        if (!PythonAvailable) return;
        var result = await new PythonTool().ExecuteAsync(Args("x = 0\nfor i in range(5):\n    x += i\nprint(x)"));

        Assert.Contains("10", result);
    }

    // ---- 失败路径 ----

    [Fact]
    public async Task Execute_Timeout_ReturnsStructuredError()
    {
        if (!PythonAvailable) return;
        var result = await new PythonTool(timeout: TimeSpan.FromMilliseconds(300))
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
        if (!PythonAvailable) return;
        var result = await new PythonTool().ExecuteAsync(Args("print(1)", "no/such/dir"));

        Assert.StartsWith("error:", result);
        Assert.Contains("目录不存在", result);
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
    public void Definition_HasNameAndSchema()
    {
        var def = new PythonTool().Definition;
        Assert.Equal("python", def.Name);
        Assert.True(def.Parameters["properties"]!["code"] is not null);
    }
}
