using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace Core.Tools;

/// <summary>
/// 持久化终端会话（第五章「命令执行环境的状态持久化」）。
/// 一个长期存活的 shell 进程，通过 stdin/stdout 交互；cd、环境变量、激活的虚拟环境等状态
/// 在多次调用之间保持。每次命令后追加退出码行（<c>_exitMarker:</c>）来界定输出边界并拿到退出码。
///
/// 平台差异：
/// - Windows（cmd.exe）：初始化用 <c>prompt &lt;tag&gt;$G</c> 设唯一提示符标签。管道 stdin 下
///   cmd 对每条输入都回显（<c>@echo off</c> 实测无效，且会让回显变成无前缀裸行无法剥离，故不设），
///   每条回显都以 <c>DI_&lt;tag&gt;&gt;</c> 开头 → 输出清理时按标签剥离；标记行是真实输出、无前缀，
///   不误剥。
/// - 其他平台（/bin/sh）：管道模式不回显、无横幅，直接收集输出。
/// - PowerShell（-Command -）：不回显；特殊初始化（进度抑制 + $LASTEXITCODE 归零）。
///
/// <b>编码（2026-10-13 修复）</b>：每次命令的 stdout/stderr 按<b>原始字节</b>收集，命令结束时
/// 各自整段用 <see cref="ProcessEncoding.SmartDecode"/> 解码（UTF-8 严格优先、OEM 回退）。
/// 原因：同一会话里既可能跑 cmd 内建命令（写系统 OEM/GBK 字节，如中文文件名的 dir），也可能跑
/// .NET CLI（stdout 被重定向时强制写 UTF-8，chcp 无效，如 dotnet build）——按命令整段判定编码
/// 两种都能解对；按固定编码流式解码会把其中一种解成乱码。每段独立判定，不会互相污染。
///
/// 超时或命令本身执行 exit 都会终止会话；下一次调用自动重建（自愈）。
/// 会话内部串行执行命令（同一时刻只有一条命令在跑）。
/// </summary>
public sealed class ShellSession : IDisposable
{
    private readonly string _workingDirectory;
    private readonly ShellCommand _shell;
    private readonly SemaphoreSlim _serial = new(1, 1);

    private Process? _process;
    private string _tag = string.Empty;      // Windows：PROMPT 标签；回显行以它开头
    private byte[] _echoPrefix = [];         // ASCII(_tag + ">")，字节级回显行过滤用
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
            var stdout = new BoundedByteBuffer();
            var stderr = new BoundedByteBuffer();

            try
            {
                await _process.StandardInput.WriteLineAsync(command).ConfigureAwait(false);
                await _process.StandardInput.WriteLineAsync(MarkerLine()).ConfigureAwait(false);
                await _process.StandardInput.FlushAsync().ConfigureAwait(false);

                // stderr 后台排干（有界字节缓冲）；stdout 读到退出码行后取消，两条流分别解码再拼接。
                using var drainCts = CancellationTokenSource.CreateLinkedTokenSource(cts.Token);
                var stderrTask = DrainAsync(_process.StandardError.BaseStream, stderr, drainCts.Token);

                var exitCode = await ReadUntilExitLineAsync(
                    _process.StandardOutput.BaseStream, stdout, cts.Token).ConfigureAwait(false);

                drainCts.Cancel();
                await WaitSilentlyAsync(stderrTask).ConfigureAwait(false);

                // 先剥掉字节级回显行（cmd 每条输入都回显，回显行是 GBK 字节；若不剥，与 .NET CLI 的
                // UTF-8 输出混在同一段里，整段 SmartDecode 会因 GBK 字节误回退 OEM，把 UTF-8 中文解乱），
                // 再整段解码。
                var text = CleanOutput(DecodeStdout(stdout)) + CleanOutput(DecodeStderr(stderr));
                return new ProcessResult(exitCode, text, null);
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
                var partial = CleanOutput(DecodeStdout(stdout)) + CleanOutput(DecodeStderr(stderr));
                return new ProcessResult(-1, partial,
                    $"执行超过 {timeout.TotalSeconds:0} 秒未完成，已终止终端会话（下次调用自动重建）");
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
        _echoPrefix = Encoding.ASCII.GetBytes(_tag + ">");
        _marker = "DI_END_" + Guid.NewGuid().ToString("N");
        _exitMarker = _marker + "_exit";
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
            // 不设 StandardOutput/ErrorEncoding：按原始字节读取，命令结束时整段智能解码
            // （UTF-8 优先 / OEM 回退）——同一会话可能混跑 cmd（OEM 字节）与 .NET CLI（UTF-8 字节）。
        };
        // stdin 编码显式钉死，不随 Console.InputEncoding 漂移（并行测试/用户环境可能把它改成 UTF-8）：
        // - cmd：钉到 OEM 代码页（中文系统 = GBK）——cmd 用控制台代码页读 stdin，写 GBK 字节才对齐；
        //   StandardInputEncoding 默认 = Console.InputEncoding（测试宿主里是 936，但不可依赖）。
        // - sh：OEM 在 Unix = UTF-8，钉 ChildOutput 同样正确。
        // - PowerShell：-Command - 按 UTF-8 读 stdin（重定向默认）；必须用"无 BOM"的 UTF-8——
        //   Encoding.UTF8 的 StreamWriter 会在流开头写 EF BB BF，PS 5.1 不剥 BOM，第一条命令
        //   首字符被搅成"命令未找到"错误。
        psi.StandardInputEncoding = IsPowerShell()
            ? new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)
            : ProcessEncoding.ChildOutput;
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
    }

    /// <summary>
    /// 初始化：cmd 先 @echo off（默认关回显，字节级扫描只命中真退出码行）再设提示符标签；
    /// PowerShell 前置进度抑制与退出码归零；都回显就绪标记，排空横幅/回显到会话真正就绪。
    /// </summary>
    private async Task<ProcessResult> InitializeAsync(CancellationToken cancellationToken)
    {
        var ready = _tag + "ready";
        try
        {
            // cmd 刻意不开 @echo off：实测管道 stdin 下 cmd 对每条输入都回显，@echo off 既不抑制
            // 回显、还会把回显从"提示符标签开头"变成"裸行"，导致 CleanOutput 无法剥离。
            // 保持回显开着 + 提示符标签 = 每条回显都以 DI_<tag>> 开头 → 可剥离；标记行是真实输出，无前缀。
            // 提示符标签只给 cmd/sh（回显过滤用）；PowerShell 不回显、prompt 函数也不接受参数，
            // 写了只会产生"命令未找到"噪音。
            if (!IsPowerShell())
                await _process!.StandardInput.WriteLineAsync($"prompt {_tag}$G").ConfigureAwait(false);
            if (IsPowerShell())
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
            var readyBytes = Encoding.ASCII.GetBytes(ready);
            var found = await ReadUntilReadyAsync(
                _process!.StandardOutput.BaseStream, readyBytes, cts.Token).ConfigureAwait(false);
            if (!found)
                return new ProcessResult(-1, string.Empty, "终端会话初始化失败（进程提前退出）");
            _initialized = true;
            return new ProcessResult(0, string.Empty, null);
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
    private bool IsPowerShell() => _shell.SessionKind == ShellSessionKind.PowerShell;

    /// <summary>
    /// 读 stdout 原始字节，直到找到退出码行边界（<c>\n</c> + <c>_exitMarker:</c>，跨块用 carry 衔接）。
    /// 边界之前的字节全部进 <paramref name="output"/>（含命令输出与标记行，解码后由 <see cref="CleanOutput"/>
    /// 剥离）；边界之后读到换行得到退出码。找不到边界（会话提前结束）返回进程退出码。
    /// 用退出码行而非标记行作边界：即使会话被用户手动开了回显（echo on），回显行以提示符标签开头、
    /// 不会以 <c>\n_exitMarker:</c> 开头，因此仍能精确定位真正的退出码行。
    /// </summary>
    private async Task<int> ReadUntilExitLineAsync(Stream stdout, BoundedByteBuffer output,
        CancellationToken cancellationToken)
    {
        // 边界只到 _exitMarker（不含冒号）：让 leading 从 ":3\r\n" 开始，退出码行解析仍能找到
        // _exitMarker: 前缀。若把冒号也吞进边界，leading 只剩数字，解析器找不到前缀会默认返回 0。
        var exitMarkerBytes = Encoding.ASCII.GetBytes("\n" + _exitMarker);
        var buffer = new byte[8192];
        var carry = new byte[exitMarkerBytes.Length - 1];
        var carryLen = 0;

        while (true)
        {
            var n = await stdout.ReadAsync(buffer, 0, buffer.Length, cancellationToken).ConfigureAwait(false);
            if (n <= 0)
                break;   // 会话结束而未见到退出码行

            // combined 只用于跨块搜索标记（carry 已在上一轮进过输出，绝不能重复追加——重复会
            // 注入字节碎片，把干净的 UTF-8 流搅成"严格解码失败"，进而整段误回退 OEM 乱码）。
            var combined = new byte[carryLen + n];
            Buffer.BlockCopy(carry, 0, combined, 0, carryLen);
            Buffer.BlockCopy(buffer, 0, combined, carryLen, n);

            var at = IndexOf(combined, exitMarkerBytes);
            if (at >= 0)
            {
                // 只追加"新字节中位于标记之前"的部分（carry 部分不重复）。
                var newBefore = at - carryLen;
                if (newBefore > 0)
                    output.Append(buffer, newBefore);
                var leading = new byte[combined.Length - (at + exitMarkerBytes.Length)];
                Buffer.BlockCopy(combined, at + exitMarkerBytes.Length, leading, 0, leading.Length);
                return await ParseExitLineAsync(stdout, leading, cancellationToken).ConfigureAwait(false);
            }

            output.Append(buffer, n);
            carryLen = Math.Min(exitMarkerBytes.Length - 1, combined.Length);
            Buffer.BlockCopy(combined, combined.Length - carryLen, carry, 0, carryLen);
        }

        return _process is not null && _process.HasExited ? _process.ExitCode : -1;
    }

    /// <summary>
    /// 解析退出码行：边界（\n + _exitMarker）之后的字节 + 继续读 stdout 到换行。
    /// leading 以冒号开头（如 ":3\r\n"），取冒号后的数字。找不到数字（边界误命中）返回 0。
    /// </summary>
    private async Task<int> ParseExitLineAsync(Stream stdout, byte[] leading,
        CancellationToken cancellationToken)
    {
        var line = new List<byte>(leading.Length + 16);
        line.AddRange(leading);
        var buffer = new byte[256];
        while (true)
        {
            var nl = line.IndexOf((byte)'\n');
            if (nl >= 0)
            {
                line.RemoveRange(nl, line.Count - nl);
                break;
            }
            if (line.Count > 512)
                break;   // 防护：退出码行不可能这么长
            var n = await stdout.ReadAsync(buffer, 0, buffer.Length, cancellationToken).ConfigureAwait(false);
            if (n <= 0)
                break;
            line.AddRange(buffer.AsSpan(0, n).ToArray());
        }
        var text = Encoding.ASCII.GetString(line.ToArray()).Trim();
        var colon = text.LastIndexOf(':');
        var number = colon >= 0 ? text[(colon + 1)..] : text;
        return int.TryParse(number, out var code) ? code : 0;
    }

    /// <summary>
    /// 初始化期：消费输出直到"一行恰好为 ready"（echo {ready} 的输出行），并把该行<b>整行含行尾换行</b>
    /// 一起消费掉——否则行尾的 \r\n 残留在流里，污染第一条命令的输出（PS 会话首命令输出曾出现 \n\n 前缀）。
    /// 搜索目标 "\n" + ready（ready 必须是行首）；用合成前导 \n 覆盖"流首即是 ready 行"（PS 无横幅）。
    /// cmd 回显行（DI_&lt;tag&gt;&gt;echo {ready}）因 ready 前面是 "echo " 而非换行，不会命中。
    /// </summary>
    private static async Task<bool> ReadUntilReadyAsync(Stream stdout, byte[] ready,
        CancellationToken cancellationToken)
    {
        var target = new byte[ready.Length + 1];
        target[0] = (byte)'\n';
        Buffer.BlockCopy(ready, 0, target, 1, ready.Length);

        var buffer = new byte[8192];
        var carry = new byte[target.Length - 1];
        var carryLen = 1;          // 合成前导 \n：流首即 ready 行也能命中
        carry[0] = (byte)'\n';

        while (true)
        {
            var n = await stdout.ReadAsync(buffer, 0, buffer.Length, cancellationToken).ConfigureAwait(false);
            if (n <= 0)
                return false;   // 会话结束而未见到 ready 行
            var combined = new byte[carryLen + n];
            Buffer.BlockCopy(carry, 0, combined, 0, carryLen);
            Buffer.BlockCopy(buffer, 0, combined, carryLen, n);

            var at = IndexOf(combined, target);
            if (at >= 0)
            {
                // 找到 ready 行首，消费到该行行尾（下一个 \n），整行丢弃；行尾可能跨块。
                var searchFrom = at + target.Length;
                var nl = Array.IndexOf(combined, (byte)'\n', searchFrom);
                if (nl >= 0)
                    return true;
                while (true)
                {
                    var n2 = await stdout.ReadAsync(buffer, 0, buffer.Length, cancellationToken).ConfigureAwait(false);
                    if (n2 <= 0)
                        return true;   // 行尾被截断（会话结束），ready 已出现，算成功
                    if (Array.IndexOf(buffer, (byte)'\n', 0, n2) >= 0)
                        return true;
                }
            }

            carryLen = Math.Min(target.Length - 1, combined.Length);
            Buffer.BlockCopy(combined, combined.Length - carryLen, carry, 0, carryLen);
        }
    }

    /// <summary>
    /// 解码 stdout：先在<b>字节层</b>剥掉回显行（cmd 每条输入都回显，回显行是 GBK 字节；不剥会与
    /// .NET CLI 的 UTF-8 输出混在同一段，整段 SmartDecode 误回退 OEM 把 UTF-8 中文解乱），再整段解码。
    /// </summary>
    private string DecodeStdout(BoundedByteBuffer output)
        => output.ToText(bytes => StripEchoLines(bytes, _echoPrefix), ProcessEncoding.SmartDecode);

    /// <summary>解码 stderr：无回显行，直接整段智能解码。</summary>
    private static string DecodeStderr(BoundedByteBuffer output)
        => output.ToText(ProcessEncoding.SmartDecode);

    /// <summary>
    /// 字节级回显行过滤：按 \n 逐行，剥掉以 <paramref name="echoPrefix"/>（提示符标签 + &gt;）开头的行。
    /// 回显行是 cmd 对每条输入的回显（DI_&lt;tag&gt;&gt;command），标记行/真实输出不以标签开头，不误剥。
    /// </summary>
    private static byte[] StripEchoLines(byte[] raw, byte[] echoPrefix)
    {
        if (echoPrefix.Length == 0 || raw.Length == 0)
            return raw;
        var result = new List<byte>(raw.Length);
        var lineStart = 0;
        for (var i = 0; i < raw.Length; i++)
        {
            if (raw[i] != (byte)'\n')
                continue;
            if (!StartsWith(raw, lineStart, i - lineStart, echoPrefix))
            {
                result.AddRange(raw.AsSpan(lineStart, i - lineStart + 1));   // 含 \n
            }
            lineStart = i + 1;
        }
        if (lineStart < raw.Length && !StartsWith(raw, lineStart, raw.Length - lineStart, echoPrefix))
            result.AddRange(raw.AsSpan(lineStart));
        return result.ToArray();
    }

    /// <summary>raw[offset..offset+len) 是否以 prefix 开头。</summary>
    private static bool StartsWith(byte[] raw, int offset, int len, byte[] prefix)
    {
        if (len < prefix.Length)
            return false;
        for (var i = 0; i < prefix.Length; i++)
        {
            if (raw[offset + i] != prefix[i])
                return false;
        }
        return true;
    }

    /// <summary>
    /// 把一段命令输出清理成回填文本：剥掉回显行（Windows 提示符标签开头，如 DI_&lt;tag&gt;&gt;echo ...）
    /// 与末尾的标记（可能独占一行，也可能被"无换行输出"粘在最后一行尾部，如 "xDI_END_xxx"）。
    /// </summary>
    private string CleanOutput(string decoded)
    {
        var lines = decoded.Replace("\r\n", "\n").Split('\n');
        var kept = lines.Where(l => !l.StartsWith(_tag, StringComparison.Ordinal)).ToList();
        // 去掉前导空行（cmd 上一命令结束时的提示符显示 "\r\nDI_<tag>>" 残留在本命令开头）。
        var text = string.Join("\n", kept).TrimStart('\n', '\r');
        var trimmed = text.TrimEnd('\r', ' ', '\n');
        if (trimmed.EndsWith(_marker, StringComparison.Ordinal))
            text = text[..(trimmed.Length - _marker.Length)];
        return text;
    }

    /// <summary>后台排干一个原始字节流到有界缓冲（取消/IO 错误静默）。</summary>
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

    private static async Task WaitSilentlyAsync(Task task)
    {
        try
        {
            await task.ConfigureAwait(false);
        }
        catch (Exception)
        {
            // 排干任务的取消/IO 异常已在上层吞掉。
        }
    }

    /// <summary>在字节数组中查找目标序列；未找到返回 -1。</summary>
    private static int IndexOf(byte[] haystack, byte[] needle)
    {
        if (needle.Length == 0)
            return 0;
        var last = haystack.Length - needle.Length;
        for (var i = 0; i <= last; i++)
        {
            var j = 0;
            while (j < needle.Length && haystack[i + j] == needle[j])
                j++;
            if (j == needle.Length)
                return i;
        }
        return -1;
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
    }
}
