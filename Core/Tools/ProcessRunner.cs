using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace Core.Tools;

/// <summary>
/// 一条进程命令：可执行文件 + 前缀参数（shell 工具用：cmd /c、/bin/sh -c、powershell -Command -）。
/// </summary>
public sealed record ShellCommand(string FileName, IReadOnlyList<string> PrefixArguments,
    ShellSessionKind SessionKind = ShellSessionKind.Sh)
{
    /// <summary>平台默认 shell：Windows 用 COMSPEC（cmd.exe），其他平台用 /bin/sh。</summary>
    public static ShellCommand Default { get; } = OperatingSystem.IsWindows()
        ? new ShellCommand(Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe", ["/c"], ShellSessionKind.Cmd)
        : new ShellCommand("/bin/sh", ["-c"]);

    /// <summary>
    /// 持久化会话的 shell：Windows 用 cmd.exe（无 /c，交互式读 stdin），其他平台用 /bin/sh（管道模式）。
    /// </summary>
    public static ShellCommand SessionDefault { get; } = OperatingSystem.IsWindows()
        ? new ShellCommand(Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe", [], ShellSessionKind.Cmd)
        : new ShellCommand("/bin/sh", []);

    /// <summary>
    /// PowerShell 持久化会话：-Command - 从 stdin 读命令。
    /// 输出编码策略（实测 PS 5.1）：不经 Console 编码行——宿主编译输出（Write-Output 等）走 .NET 重定向
    /// 的 UTF-8 默认编码，引擎生成的错误记录（命令不存在等）走 OEM 代码页，两条流分别解码（见 ShellSession）。
    /// </summary>
    public static ShellCommand PowerShellSession { get; } =
        new("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], ShellSessionKind.PowerShell);

    /// <summary>是否为平台默认 shell（BashTool 借此决定用哪种命令行构造方式）。</summary>
    public bool IsPlatformDefault => ReferenceEquals(this, Default);

    /// <summary>是否为平台默认会话 shell。</summary>
    public bool IsSessionDefault => ReferenceEquals(this, SessionDefault);
}

/// <summary>终端会话的 shell 变体：决定回显过滤、初始化与标记行的语法。</summary>
public enum ShellSessionKind
{
    /// <summary>Windows cmd.exe：管道模式回显"提示符+命令"，标记行用 %errorlevel%。</summary>
    Cmd,

    /// <summary>/bin/sh：不回显，标记行用 $?。</summary>
    Sh,

    /// <summary>PowerShell 5.1：不回显，标记行用 $? + $LASTEXITCODE（cmdlet 成功→0、原生失败→真实码、未找到→1）。</summary>
    PowerShell,
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
    /// <summary>进程退出后，等待异步读事件把残留输出派发完的最长时间（毫秒）。
    /// 不带超时的 WaitForExit() 可能被继承了 stdout/stderr 管道的后台子进程挂住，
    /// 所以这里必须有界。</summary>
    private const int DrainTimeoutMs = 1000;

    public static async Task<ProcessResult> RunAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        TimeSpan timeout,
        CancellationToken cancellationToken,
        string? rawArguments = null,
        Encoding? outputEncoding = null)
    {
        var psi = new ProcessStartInfo
        {
            FileName = fileName,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            // 默认显式用 OEM 代码页解码，避免按 Console.OutputEncoding（真实 CLI 里是 UTF-8）解出乱码。
            // 个别原生写 UTF-8 的工具（如 git）可传 outputEncoding 覆盖。
            StandardOutputEncoding = outputEncoding ?? ProcessEncoding.ChildOutput,
            StandardErrorEncoding = outputEncoding ?? ProcessEncoding.ChildOutput,
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
        // 有界累积：边收边丢，任意长度的输出都不会把内存打爆（见 OutputBuffer）。
        var output = new OutputBuffer();
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
                output.Text,
                $"执行超过 {timeout.TotalSeconds:0} 秒未完成，已终止");
        }

        // 排干：WaitForExitAsync 只等进程退出，BeginOutputReadLine 的最后几行事件可能
        // 还没派发完，直接读会丢尾部。带超时的 WaitForExit 等异步读收尾（有界，不挂）。
        process.WaitForExit(DrainTimeoutMs);
        return new ProcessResult(process.ExitCode, output.Text, null);
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
