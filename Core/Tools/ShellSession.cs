using System.ComponentModel;
using System.Diagnostics;
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
///
/// 超时或命令本身执行 exit 都会终止会话；下一次调用会自动重建（自愈）。
/// 会话内部串行执行命令（同一时刻只有一条命令在跑）。
/// </summary>
public sealed class ShellSession : IDisposable
{
    /// <summary>单条命令最多收集的输出行数（内存上限，仍会继续读取到标记为止）。</summary>
    private const int MaxCollectedLines = 2000;

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
            var output = new List<string>();

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
                        Add(output, line[..^_marker.Length]);
                        break;
                    }
                    if (IsEchoLine(line))
                        continue;   // Windows：丢弃"提示符+命令"回显行
                    Add(output, line);
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

                return new ProcessResult(exitCode, ToolHelpers.Truncate(string.Join('\n', output)), null);
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
                return new ProcessResult(-1, ToolHelpers.Truncate(string.Join('\n', output)),
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

        var psi = new ProcessStartInfo
        {
            FileName = _shell.FileName,
            WorkingDirectory = _workingDirectory,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
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

    /// <summary>初始化：Windows 设置提示符标签；两边都回显就绪标记，排空横幅/回显到会话真正就绪。</summary>
    private async Task<ProcessResult> InitializeAsync(CancellationToken cancellationToken)
    {
        var ready = _tag + "ready";
        try
        {
            if (IsWindowsCmd())
                await _process!.StandardInput.WriteLineAsync($"prompt {_tag}$G").ConfigureAwait(false);
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

    private string MarkerLine() => IsWindowsCmd()
        ? $"echo {_marker} & echo {_exitMarker}:%errorlevel%"
        : $"__di_rc=$?; echo {_marker}; echo {_exitMarker}:$__di_rc";

    private bool IsWindowsCmd() => OperatingSystem.IsWindows() && _shell.IsSessionDefault;

    private bool IsEchoLine(string line) => IsWindowsCmd() && line.StartsWith(_tag, StringComparison.Ordinal);

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

    private static void Add(List<string> output, string line)
    {
        if (output.Count < MaxCollectedLines)
            output.Add(line);
    }

    private ProcessResult SessionEnded(List<string> output)
    {
        var rc = _process is not null && _process.HasExited ? _process.ExitCode : -1;
        _process = null;
        return new ProcessResult(rc, ToolHelpers.Truncate(string.Join('\n', output)), null);
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
