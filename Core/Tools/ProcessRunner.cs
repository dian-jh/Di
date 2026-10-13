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
    /// <summary>进程退出后，等待 stdout/stderr 两个字节排干任务收尾的最长时间（毫秒）。
    /// 不带超时等 EOF 可能被继承了管道的后台子进程挂住，所以这里必须有界。</summary>
    private const int DrainTimeoutMs = 1000;

    public static async Task<ProcessResult> RunAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        string workingDirectory,
        TimeSpan timeout,
        CancellationToken cancellationToken,
        string? rawArguments = null,
        Encoding? outputEncoding = null,
        IReadOnlyDictionary<string, string>? environment = null)
    {
        var psi = new ProcessStartInfo
        {
            FileName = fileName,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            // 不设 StandardOutput/ErrorEncoding：按原始字节读取、命令结束时整段解码。默认用
            // ProcessEncoding.SmartDecode（UTF-8 严格优先、OEM 回退）——cmd 内建命令写系统
            // OEM/GBK 字节（中文文件名 dir），而 .NET CLI 重定向 stdout 时强制写 UTF-8（chcp 无效），
            // 按固定编码流式解码会把其中一种解成乱码。个别原生工具（git/python）可传 outputEncoding
            // 钉死（如 UTF-8），跳过智能判定。
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
        if (environment is not null)
        {
            foreach (var (key, value) in environment)
                psi.Environment[key] = value;
        }

        using var process = new Process { StartInfo = psi };
        // 有界字节累积：边收边丢，任意长度的输出都不会把内存打爆（见 BoundedByteBuffer）。
        // 整段保留原始字节，退出后统一解码，避免流式解码锁死编码（见上方 psi 注释）。
        var output = new BoundedByteBuffer();

        try
        {
            if (!process.Start())
                return new ProcessResult(-1, string.Empty, "无法启动进程");
        }
        catch (Exception ex) when (ex is Win32Exception or IOException)
        {
            return new ProcessResult(-1, string.Empty, $"无法启动进程: {ex.Message}");
        }

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(timeout);
        // stdout/stderr 并发排干到同一缓冲（BoundedByteBuffer.Append 线程安全）。
        var stdoutTask = DrainAsync(process.StandardOutput.BaseStream, output, cts.Token);
        var stderrTask = DrainAsync(process.StandardError.BaseStream, output, cts.Token);

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
                Decode(output, outputEncoding),
                $"执行超过 {timeout.TotalSeconds:0} 秒未完成，已终止");
        }

        // 排干：等两个读取任务收尾；若后台子进程继承了管道，EOF 永不出现 → 有界等（不挂）。
        using var drainCts = CancellationTokenSource.CreateLinkedTokenSource(cts.Token);
        drainCts.CancelAfter(DrainTimeoutMs);
        try
        {
            await Task.WhenAll(stdoutTask, stderrTask).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // 排干超时：尾部可能还有后台子进程输出，放弃等待。
        }

        return new ProcessResult(process.ExitCode, Decode(output, outputEncoding), null);
    }

    /// <summary>整段解码：传了 outputEncoding 用钉死编码，否则 UTF-8 优先 / OEM 回退智能判定。</summary>
    private static string Decode(BoundedByteBuffer output, Encoding? outputEncoding)
        => outputEncoding is not null
            ? output.ToText(bytes => outputEncoding.GetString(bytes))
            : output.ToText(ProcessEncoding.SmartDecode);

    /// <summary>把原始字节流排干到有界缓冲（取消/IO 错误静默）。</summary>
    private static async Task DrainAsync(Stream stream, BoundedByteBuffer output, CancellationToken cancellationToken)
    {
        var buffer = new byte[8192];
        try
        {
            while (true)
            {
                var n = await stream.ReadAsync(buffer, 0, buffer.Length, cancellationToken).ConfigureAwait(false);
                if (n <= 0)
                    break;
                output.Append(buffer, n);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (IOException)
        {
        }
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
