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
            {
                Diagnose($"proc: start_failed name={fileName} reason=无法启动进程");
                return new ProcessResult(-1, string.Empty, "无法启动进程");
            }
        }
        catch (Exception ex) when (ex is Win32Exception or IOException)
        {
            Diagnose($"proc: start_failed name={fileName} error={TruncateField(ex.Message)}");
            return new ProcessResult(-1, string.Empty, $"无法启动进程: {ex.Message}");
        }

        // 进程级诊断（proc: start / running / timeout / exited，经 ProcessDiagnostics 旁路钩子）：
        // 记录实际解析到的可执行文件、PID、命令行，以及超时点 CPU 用量与已收到输出——
        // 用于区分"启动即卡死"（cpu≈0 且无输出，如依赖的环境/解析/一次性扫描问题）与
        // "在跑但慢"（cpu 持续增长）。定位工具调用神秘超时正是靠这些字段。
        var elapsed = Stopwatch.StartNew();
        if (ProcessDiagnostics.Log is not null)
        {
            Diagnose($"proc: start name={Path.GetFileName(fileName)} exe={ResolveExecutable(process, fileName)}" +
                     $" pid={process.Id} timeout_s={timeout.TotalSeconds:0} cwd={TruncateField(workingDirectory)}" +
                     $" stdinRedirected={Console.IsInputRedirected} cmd=<<{TruncateField(BuildCommandLine(process, fileName, arguments, rawArguments))}>>");
            // 心跳监控（5s 一条，cpu_ms 判 busy vs 卡死）：超时 ≥3s 才值得开。
            if (timeout >= TimeSpan.FromSeconds(3))
                _ = StartHeartbeatMonitorAsync(process, timeout, Path.GetFileName(fileName));
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
            // 诊断行带超时点 CPU 用量与已收到的部分输出；既无输出又 cpu≈0 → 启动即卡死。
            var partial = Decode(output, outputEncoding);
            if (ProcessDiagnostics.Log is not null)
                Diagnose($"proc: timeout name={Path.GetFileName(fileName)} pid={process.Id} elapsed_ms={elapsed.ElapsedMilliseconds}" +
                         $" cpu_ms={CpuMilliseconds(process)} partial=<<{TruncateField(partial, 300)}>>");
            Kill(process);
            return new ProcessResult(-1, partial, $"执行超过 {timeout.TotalSeconds:0} 秒未完成，已终止");
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

        // 慢速成功（≥2s）也留一条：正常命令几秒级常见，留证可对照超时点的 cpu 判断是否本来就慢。
        if (ProcessDiagnostics.Log is not null && elapsed.ElapsedMilliseconds >= 2000)
            Diagnose($"proc: exited name={Path.GetFileName(fileName)} pid={process.Id} exit={process.ExitCode}" +
                     $" elapsed_ms={elapsed.ElapsedMilliseconds} cpu_ms={CpuMilliseconds(process)}");

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

    // ---- 进程级诊断（proc: 行，见 ProcessDiagnostics）----

    /// <summary>发一行进程诊断：钩子可空 + 自身异常隔离——诊断绝不影响执行（旁路观察）。</summary>
    private static void Diagnose(string message)
    {
        try { ProcessDiagnostics.Log?.Invoke(message); }
        catch { }
    }

    /// <summary>进程已消耗的 CPU 毫秒（进程已退出等情形兜底返回 0）。</summary>
    private static long CpuMilliseconds(Process process)
    {
        try { return (long)process.TotalProcessorTime.TotalMilliseconds; }
        catch { return 0; }
    }

    /// <summary>
    /// 实际解析到的可执行文件路径（要诊断 WindowsApps 别名等解析漂移，必须拿到真实路径而非配置名）。
    /// <see cref="Process.MainModule"/> 在 Start() 后立刻读存在已知竞态（进程 PE 头未就绪抛 Win32Exception），
    /// 短重试（最多 3 次 × 20ms）骑过竞态，仍失败才退回配置的 fileName（如 "python"）。
    /// </summary>
    private static string ResolveExecutable(Process process, string fileName)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                var resolved = process.MainModule?.FileName;
                if (!string.IsNullOrWhiteSpace(resolved))
                    return resolved;
            }
            catch
            {
                // 竞态未就绪：短暂退避后重试；最后一次失败落回 fileName。
            }
            if (attempt < 2)
                Thread.Sleep(20);
        }
        return fileName;
    }

    /// <summary>拼命令行：优先读 Start 后 .NET 生成的完整行（AppendArgumentList 也在此刻成型），退回手工拼接。</summary>
    private static string BuildCommandLine(Process process, string fileName, IReadOnlyList<string> arguments, string? rawArguments)
    {
        try
        {
            var joined = process.StartInfo.Arguments;
            if (!string.IsNullOrWhiteSpace(joined))
                return fileName + " " + joined;
        }
        catch { }
        return rawArguments is not null
            ? $"{fileName} {rawArguments}"
            : fileName + " " + string.Join(' ', arguments);
    }

    /// <summary>诊断字段折叠：控制字符压空格、超长截断（日志单行可扫视）。</summary>
    private static string TruncateField(string text, int max = 200)
    {
        var flat = text.Replace('\r', ' ').Replace('\n', ' ');
        return flat.Length <= max ? flat : flat[..max] + "…";
    }

    /// <summary>
    /// 心跳监控：进程存活期间每 5s 发一行（elapsed + cpu），进程退出即停。随父方法 while 结束而自然停止；
    /// 父方法释放 process 后任一成员访问抛异常，被整体兜底捕获。返回 Task 由调用方丢弃，内部已全捕获。
    /// </summary>
    private static async Task StartHeartbeatMonitorAsync(Process process, TimeSpan timeout, string name)
    {
        var sw = Stopwatch.StartNew();
        long lastBeat = 0;
        try
        {
            while (!process.HasExited && sw.Elapsed < timeout)
            {
                await Task.Delay(1000).ConfigureAwait(false);
                if (process.HasExited)
                    break;
                var elapsedMs = sw.ElapsedMilliseconds;
                if (elapsedMs - lastBeat >= 5000)
                {
                    lastBeat = elapsedMs;
                    Diagnose($"proc: running name={name} pid={process.Id} elapsed_ms={elapsedMs} cpu_ms={CpuMilliseconds(process)}");
                }
            }
        }
        catch
        {
            // 进程已释放 / 查询失败：心跳静默停止。
        }
    }
}
