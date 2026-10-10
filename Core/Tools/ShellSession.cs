using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Threading.Channels;

namespace Core.Tools;

/// <summary>
/// 持久化终端会话（第五章「命令执行环境的状态持久化」）。
/// 一个长期存活的 shell 进程，通过 stdin/stdout 交互；cd、环境变量、激活的虚拟环境等状态
/// 在多次调用之间保持。每次命令后追加一行唯一标记来界定输出边界，并从退出码行解析结果。
///
/// 平台差异：
/// - Windows（cmd.exe）：交互式管道模式会回显"提示符+命令"，初始化时用 <c>prompt &lt;tag&gt;$G</c>
///   把提示符设成唯一标签，读取输出时丢弃以该标签开头的回显行。
/// - 其他平台（/bin/sh）：管道模式不回显、无横幅，直接收集输出。
/// - PowerShell（-Command -）：不回显；输出编码按流拆分——stdout 按 UTF-8（.NET 重定向默认），
///   stderr 按 OEM（PS 5.1 引擎错误记录写 OEM 字节，实测）。
///
/// 编码注意：PowerShell 会话的初始化前缀<b>不设置</b> [Console]::OutputEncoding —— 一旦改动，
/// PS 5.1 宿主会把 stdin 读成 OEM 代码页，中文命令从 stdin 进入时乱码（实测）。保持默认
/// （stdin 与宿主编译输出均为 UTF-8）即可让中文命令与中文输出两端无损。
///
/// 超时或命令本身执行 exit 都会终止会话；下一次调用会自动重建（自愈）。
/// 会话内部串行执行命令（同一时刻只有一条命令在跑）。
/// </summary>
public sealed class ShellSession : IDisposable
{
    private readonly string _workingDirectory;
    private readonly ShellCommand _shell;
    private readonly SemaphoreSlim _serial = new(1, 1);

    private Process? _process;
    private Channel<string> _lines = Channel.CreateUnbounded<string>();
    private string _tag = string.Empty;      // Windows：PROMPT 标签；回显行以它开头
    private string _marker = string.Empty;
    private string _exitMarker = string.Empty;
    private string? _spawnError;
    private bool _initialized;
    private bool _disposed;

    public ShellSession(string workingDirectory, ShellCommand? shell = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(workingDirectory);
        _workingDirectory = workingDirectory;
        _shell = shell ?? ShellCommand.SessionDefault;
    }

    /// <summary>会话进程是否还活着（未启动/已退出时为 false）。</summary>
    public bool IsAlive => _process is not null && !_process.HasExited;

    public async Task<ProcessResult> ExecuteAsync(
        string command, TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        await _serial.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            lock (_gate)
            {
                EnsureAlive();
            }
            if (_process is null)
                return new ProcessResult(-1, string.Empty, _spawnError ?? "无法启动终端会话进程");
            if (!_initialized)
            {
                var init = await InitializeAsync(cancellationToken).ConfigureAwait(false);
                if (init.Error is not null)
                    return init;
            }

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(timeout);
            // 有界累积：边收边丢（头尾预算），不会因单条命令输出过大而打爆内存；
            // 超出预算会被标记为截断，而不是像旧的按行上限那样静默丢行。
            var output = new OutputBuffer();

            try
            {
                await _process.StandardInput.WriteLineAsync(command).ConfigureAwait(false);
                await _process.StandardInput.WriteLineAsync(MarkerLine()).ConfigureAwait(false);
                await _process.StandardInput.FlushAsync().ConfigureAwait(false);

                // 收集输出直到标记行（或会话进程结束）
                while (true)
                {
                    var line = await ReadLineAsync(cts.Token).ConfigureAwait(false);
                    if (line is null)
                        return SessionEnded(output);
                    if (line.TrimEnd() == _marker)
                        break;
                    if (line.EndsWith(_marker, StringComparison.Ordinal))
                    {
                        // 命令输出不带末尾换行：标记拼到了同一行末尾，前缀仍属命令输出。
                        output.AppendLine(line[..^_marker.Length]);
                        break;
                    }
                    if (IsEchoLine(line))
                        continue;   // Windows：丢弃"提示符+命令"回显行
                    output.AppendLine(line);
                }

                // 退出码行（标记之后）
                var exitCode = 0;
                while (true)
                {
                    var line = await ReadLineAsync(cts.Token).ConfigureAwait(false);
                    if (line is null)
                        return SessionEnded(output);
                    var trimmed = line.TrimStart();
                    if (trimmed.StartsWith(_exitMarker + ":", StringComparison.Ordinal))
                    {
                        var code = trimmed[(_exitMarker.Length + 1)..].Trim();
                        int.TryParse(code, out exitCode);
                        break;
                    }
                }

                return new ProcessResult(exitCode, output.Text, null);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                Kill();
                throw;   // 外部取消：让上层处理
            }
            catch (OperationCanceledException)
            {
                // 超时：按第五章返回结构化错误；终止会话，下次调用自动重建。
                Kill();
                return new ProcessResult(-1, output.Text,
                    $"执行超过 {timeout.TotalSeconds:0} 秒未完成，已终止终端会话（下次调用自动重建）");
            }
            catch (ChannelClosedException)
            {
                return SessionEnded(output);
            }
        }
        finally
        {
            _serial.Release();
        }
    }

    /// <summary>终止会话进程（幂等）。</summary>
    public void Dispose()
    {
        if (_disposed)
            return;
        _disposed = true;
        Kill();
        _serial.Dispose();
    }

    // ---- 内部 ----

    private readonly object _gate = new();

    /// <summary>确保会话进程存在；刚创建时返回 true（调用方随后做初始化排空）。</summary>
    private void EnsureAlive()
    {
        if (_process is not null && !_process.HasExited)
            return;
        Spawn();
    }

    private void Spawn()
    {
        _tag = "DI_" + Guid.NewGuid().ToString("N");
        _marker = "DI_END_" + Guid.NewGuid().ToString("N");
        _exitMarker = _marker + "_exit";
        _lines = Channel.CreateUnbounded<string>();
        _initialized = false;
        _spawnError = null;

        // PowerShell：stdout 按 UTF-8（宿主输出走 .NET 重定向默认编码）；stderr 沿用 OEM 代码页
        // （PS 5.1 引擎错误记录写 OEM 字节，实测）。其余 shell 的 stdout 也沿用 OEM（cmd/sh 写 OEM 字节）。
        var isPowerShell = _shell.SessionKind == ShellSessionKind.PowerShell;

        var psi = new ProcessStartInfo
        {
            FileName = _shell.FileName,
            WorkingDirectory = _workingDirectory,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            // 显式指定解码编码，避免按 Console.OutputEncoding（真实 CLI 里是 UTF-8）解出乱码。
            StandardOutputEncoding = isPowerShell ? Encoding.UTF8 : ProcessEncoding.ChildOutput,
            StandardErrorEncoding = ProcessEncoding.ChildOutput,
        };
        // PowerShell 从 stdin 按 UTF-8 读命令（重定向默认）；而 StandardInput 默认按 Console.InputEncoding
        // 写字节（测试宿主里是 GBK）→ 中文命令被写坏。显式钉成 UTF-8 使命令字节与 PS 读取一致。
        // cmd/sh 不设：保持既有行为（OEM 字节），避免回归。
        if (isPowerShell)
            psi.StandardInputEncoding = Encoding.UTF8;
        foreach (var arg in _shell.PrefixArguments)
            psi.ArgumentList.Add(arg);

        try
        {
            _process = Process.Start(psi);
        }
        catch (Exception ex) when (ex is Win32Exception or IOException)
        {
            _process = null;
            _spawnError = $"无法启动终端会话进程: {ex.Message}";
            return;
        }
        if (_process is null)
        {
            _spawnError = "无法启动终端会话进程";
            return;
        }

        _process.EnableRaisingEvents = true;
        _process.OutputDataReceived += (_, e) => { if (e.Data is not null) _lines.Writer.TryWrite(e.Data); };
        _process.ErrorDataReceived += (_, e) => { if (e.Data is not null) _lines.Writer.TryWrite(e.Data); };
        _process.Exited += (_, _) => _lines.Writer.TryComplete();
        _process.BeginOutputReadLine();
        _process.BeginErrorReadLine();
    }

    /// <summary>
    /// 初始化：cmd 设置提示符标签、PowerShell 前置进度抑制与退出码初始化；都回显就绪标记，
    /// 排空横幅/回显到会话真正就绪。
    /// </summary>
    private async Task<ProcessResult> InitializeAsync(CancellationToken cancellationToken)
    {
        var ready = _tag + "ready";
        try
        {
            if (IsCmd())
                await _process!.StandardInput.WriteLineAsync($"prompt {_tag}$G").ConfigureAwait(false);
            else if (_shell.SessionKind == ShellSessionKind.PowerShell)
            {
                // 前置脚本：抑制 PS 5.1 重定向 stdout 时的 CLIXML 进度流；把 $LASTEXITCODE 初始化为 0
                // （未设置时是空串，标记行的 $rc=$global:LASTEXITCODE 会解析失败）。
                // 注意：这里刻意不碰 [Console]::OutputEncoding —— 改了它 stdin 会被读成 OEM，中文命令乱码。
                await _process!.StandardInput.WriteLineAsync(
                    "$ProgressPreference='SilentlyContinue'; $global:LASTEXITCODE=0;").ConfigureAwait(false);
            }
            await _process!.StandardInput.WriteLineAsync($"echo {ready}").ConfigureAwait(false);
            await _process!.StandardInput.FlushAsync().ConfigureAwait(false);

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(TimeSpan.FromSeconds(10));
            while (true)
            {
                var line = await ReadLineAsync(cts.Token).ConfigureAwait(false);
                if (line is null)
                    return new ProcessResult(-1, string.Empty, "终端会话初始化失败（进程提前退出）");
                if (line.TrimEnd() == ready)
                {
                    _initialized = true;
                    return new ProcessResult(0, string.Empty, null);
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            Kill();
            throw;
        }
        catch (OperationCanceledException)
        {
            Kill();
            return new ProcessResult(-1, string.Empty, "终端会话初始化超时");
        }
    }

    private string MarkerLine() => _shell.SessionKind switch
    {
        ShellSessionKind.Cmd => $"echo {_marker} & echo {_exitMarker}:%errorlevel%",
        ShellSessionKind.PowerShell =>
            // PS 5.1 语义：cmdlet 成功 → $? 为 True（取 $LASTEXITCODE，初始 0）；原生命令失败 → $? 为 False
            // 且 $LASTEXITCODE 是真实码；命令不存在 → $? 为 False 且 $LASTEXITCODE 保持 0 → 兜底为 1。
            $"$ok=$?; $rc=$global:LASTEXITCODE; if (-not $ok) {{ $rc=[Math]::Max(1,$rc) }}; " +
            $"Write-Output '{_marker}'; Write-Output ('{_exitMarker}:' + $rc)",
        _ => $"__di_rc=$?; echo {_marker}; echo {_exitMarker}:$__di_rc",
    };

    private bool IsCmd() => _shell.SessionKind == ShellSessionKind.Cmd;

    // 仅 cmd 的交互式管道会回显"提示符+命令"；/bin/sh 与 PowerShell（-Command -）都不回显。
    private bool IsEchoLine(string line) => IsCmd() && line.StartsWith(_tag, StringComparison.Ordinal);

    private async Task<string?> ReadLineAsync(CancellationToken cancellationToken)
    {
        try
        {
            return await _lines.Reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (ChannelClosedException)
        {
            return null;   // 会话进程结束
        }
    }

    private ProcessResult SessionEnded(OutputBuffer output)
    {
        var rc = _process is not null && _process.HasExited ? _process.ExitCode : -1;
        _process = null;
        return new ProcessResult(rc, output.Text, null);
    }

    private void Kill()
    {
        try
        {
            _process?.Kill(entireProcessTree: true);
        }
        catch
        {
            // 进程可能已退出。
        }
        _process = null;
        _lines.Writer.TryComplete();
    }
}
