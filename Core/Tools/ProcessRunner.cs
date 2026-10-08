using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace Core.Tools;

/// <summary>
/// 一条进程命令：可执行文件 + 前缀参数（shell 工具用：cmd /c、/bin/sh -c）。
/// </summary>
public sealed record ShellCommand(string FileName, IReadOnlyList<string> PrefixArguments)
{
    /// <summary>平台默认 shell：Windows 用 COMSPEC（cmd.exe），其他平台用 /bin/sh。</summary>
    public static ShellCommand Default { get; } = OperatingSystem.IsWindows()
        ? new ShellCommand(Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe", ["/c"])
        : new ShellCommand("/bin/sh", ["-c"]);

    /// <summary>
    /// 持久化会话的 shell：Windows 用 cmd.exe（无 /c，交互式读 stdin），其他平台用 /bin/sh（管道模式）。
    /// </summary>
    public static ShellCommand SessionDefault { get; } = OperatingSystem.IsWindows()
        ? new ShellCommand(Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe", [])
        : new ShellCommand("/bin/sh", []);

    /// <summary>是否为平台默认 shell（BashTool 借此决定用哪种命令行构造方式）。</summary>
    public bool IsPlatformDefault => ReferenceEquals(this, Default);

    /// <summary>是否为平台默认会话 shell（ShellSession 借此决定回显过滤/标记行的语法）。</summary>
    public bool IsSessionDefault => ReferenceEquals(this, SessionDefault);
}

/// <summary>一次进程/会话命令执行的结果，渲染成回填给模型的观察文本。</summary>
public sealed record ProcessResult(int ExitCode, string Output, string? Error)
{
    /// <summary>渲染成回填给模型的观察文本：失败以 error: 开头，正常返回退出码 + 合并输出。</summary>
    public string ToObservation()
    {
        var trimmed = Output.TrimEnd();
        if (Error is null)
            return $"exit: {ExitCode}\n{trimmed}";
        return trimmed.Length > 0 ? $"error: {Error}\n{trimmed}" : $"error: {Error}";
    }
}

/// <summary>
/// 最小进程执行器：启动进程、合并 stdout/stderr、超时强杀（含进程树）。
/// bash / python 两个工具共享。
/// </summary>
internal static class ProcessRunner
{
    public static async Task<ProcessResult> RunAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        TimeSpan timeout,
        CancellationToken cancellationToken,
        string? rawArguments = null)
    {
        var psi = new ProcessStartInfo
        {
            FileName = fileName,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            // 显式用 OEM 代码页解码，避免按 Console.OutputEncoding（真实 CLI 里是 UTF-8）解出乱码。
            StandardOutputEncoding = ProcessEncoding.ChildOutput,
            StandardErrorEncoding = ProcessEncoding.ChildOutput,
        };
        if (rawArguments is not null)
        {
            // 原样传入整个命令行（verbatim）——cmd.exe 需要 /d /s /c "命令" 这种手工形式，
            // ArgumentList 的内嵌引号转义（\"）cmd 不认，会把反斜杠原样输出。
            psi.Arguments = rawArguments;
        }
        else
        {
            foreach (var arg in arguments)
                psi.ArgumentList.Add(arg);
        }

        using var process = new Process { StartInfo = psi };
        var output = new StringBuilder();
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) output.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data is not null) output.AppendLine(e.Data); };

        try
        {
            if (!process.Start())
                return new ProcessResult(-1, string.Empty, "无法启动进程");
        }
        catch (Exception ex) when (ex is Win32Exception or IOException)
        {
            return new ProcessResult(-1, string.Empty, $"无法启动进程: {ex.Message}");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(timeout);

        try
        {
            await process.WaitForExitAsync(cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // 外部取消（用户中断整个回合）：让上层处理，而不是当作工具失败。
            Kill(process);
            throw;
        }
        catch (OperationCanceledException)
        {
            // 超时：按第五章，超时要向 Agent 返回结构化错误而非静默杀死。
            Kill(process);
            return new ProcessResult(-1,
                ToolHelpers.Truncate(output.ToString()),
                $"执行超过 {timeout.TotalSeconds:0} 秒未完成，已终止");
        }

        return new ProcessResult(process.ExitCode, ToolHelpers.Truncate(output.ToString()), null);
    }

    private static void Kill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch
        {
            // 进程可能已经退出。
        }
    }
}
