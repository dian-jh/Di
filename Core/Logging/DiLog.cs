using System.Globalization;
using System.Text;
using Common.Events;
using Core.AgentLoop;

namespace Core.Logging;

/// <summary>
/// jcode 风格文本运行日志（参考 C:\Users\52143\.jcode\logs）：
/// 每行 <c>[yyyy-MM-dd HH:mm:ss.fff] [LEVEL] message</c>，按日一个文件
/// <c>~/.di/logs/di-YYYY-MM-DD.log</c>（本地时间，与 jcode 一致）。
///
/// 写法：<see cref="Subscribe"/> 在事件总线旁路订阅 <see cref="IEvent"/>（push 模式，fan-out，
/// 一次订阅恰好每事件一次），把回合生命周期事件翻译成日志行；<see cref="Log"/> 供宿主写
/// <c>di starting</c> 等非事件行。全程<b>静默兜底</b>：IO 失败（目录不可写 / 磁盘满 / 被删）
/// 只丢弃当行，绝不抛异常、绝不影响主流程（日志是旁路观察，见 docs/modules/events.md）。
///
/// 时间线（用户输入 → 模型发起 → 模型返回）：
/// <code>
/// [INFO] di starting pid=.. version=.. workspace=..
/// [INFO] run: started user_input=&lt;折叠&gt;
/// [INFO] llm: call_started iteration=1
/// [INFO] llm: call_completed iteration=1 duration_ms=.. tokens_in=.. tokens_out=.. finish=stop
/// [INFO] tool: started name=..
/// [INFO] tool: completed name=..
/// [ERROR] llm: run_failed code=.. error=.. duration_ms=..
/// [INFO] di exiting
/// </code>
/// 设计文档见 docs/modules/logging.md。
/// </summary>
public sealed class DiLog : IDisposable
{
    /// <summary>单字段展示上限：用户输入 / 工具观察等长文本折叠后仍超长则截断（完整文本在会话 JSONL）。</summary>
    private const int MaxFieldLength = 300;

    private static readonly UTF8Encoding Utf8NoBom = new(encoderShouldEmitUTF8Identifier: false);

    private readonly DiLogOptions _options;
    private readonly object _lock = new();

    private StreamWriter? _writer;
    private string? _fileKey;   // 当前打开文件的日期键（yyyy-MM-dd），按日轮转依据
    private IDisposable? _subscription;
    private (int Iteration, DateTimeOffset StartedAt)? _lastModelCall;   // 最近一次在途模型调用的起始时刻
    private bool _disposed;

    public DiLog(DiLogOptions? options = null)
    {
        _options = options ?? new DiLogOptions();
        try
        {
            OpenWriter(_options.Clock());
        }
        catch (Exception)
        {
            // 目录/文件打开失败：进入静默兜底，之后所有写变 no-op。
        }
    }

    /// <summary>在事件总线旁路订阅 IEvent，把生命周期事件翻译成日志行。幂等。</summary>
    public void Subscribe(IEventBus bus)
    {
        ArgumentNullException.ThrowIfNull(bus);
        if (_subscription is not null)
            return;
        _subscription = bus.Subscribe<IEvent>(HandleAsync);
    }

    /// <summary>写一行 jcode 格式日志（供宿主写 di starting 等非事件行）。</summary>
    public void Log(LogLevel level, string message)
    {
        ArgumentNullException.ThrowIfNull(message);
        WriteLine(level, message, durationMs: null);
    }

    /// <summary>写 di exiting、flush、关文件、退订。幂等。</summary>
    public void Dispose()
    {
        lock (_lock)
        {
            if (_disposed)
                return;
            _disposed = true;

            _subscription?.Dispose();
            _subscription = null;

            // 退出行走无守卫的 WriteLineCore（WriteLine 的 _disposed 守卫会拦掉它），再关文件。
            WriteLineCore(LogLevel.Info, "di exiting", durationMs: null);
            _writer?.Dispose();
            _writer = null;
        }
    }

    /// <summary>事件 → 日志行。流式增量（TextDelta/ReasoningDelta/ToolCallDelta）是逐字噪声，
    /// 完整文本已在 sessions/*.jsonl，这里跳过；其余回合生命周期事件各落一行。</summary>
    private Task HandleAsync(IEvent evt, CancellationToken cancellationToken)
    {
        switch (evt)
        {
            case RunStarted r:
                WriteLine(LogLevel.Info, $"run: started user_input={Collapse(r.UserMessage)}", durationMs: null);
                break;

            case ModelCallStarted m:
                lock (_lock)
                    _lastModelCall = (m.Iteration, m.CreatedAt);
                WriteLine(LogLevel.Info, $"llm: call_started iteration={m.Iteration}", durationMs: null);
                break;

            case AgentLoopEvent.TurnCompleted t:
                WriteLine(LogLevel.Info, BuildCompletedLine(t), durationMs: TakeDuration(t.CreatedAt));
                break;

            case AgentLoopEvent.RunFailed f:
                WriteLine(LogLevel.Error, $"llm: run_failed code={f.Failure.Code} error={Collapse(f.Failure.Message)}",
                    durationMs: TakeDuration(f.CreatedAt));
                break;

            case AgentLoopEvent.ToolStarted s:
                WriteLine(LogLevel.Info, $"tool: started name={s.Call.Name}", durationMs: null);
                break;

            case AgentLoopEvent.ToolCompleted c when c.IsError:
                WriteLine(LogLevel.Warn, $"tool: failed name={c.Call.Name} error={Collapse(c.Observation)}", durationMs: null);
                break;

            case AgentLoopEvent.ToolCompleted c:
                WriteLine(LogLevel.Info, $"tool: completed name={c.Call.Name}", durationMs: null);
                break;

            case AgentLoopEvent.Interrupted:
                WriteLine(LogLevel.Info, "run: interrupted", durationMs: null);
                break;
        }

        return Task.CompletedTask;
    }

    /// <summary>模型调用完成行：迭代号 + 耗时（回-起，单槽取一次即清）+ token 用量 + 成本 + 停止原因。</summary>
    private static string BuildCompletedLine(AgentLoopEvent.TurnCompleted t)
    {
        var sb = new StringBuilder(96)
            .Append("llm: call_completed iteration=").Append(t.Iteration)
            .Append(" tokens_in=").Append(t.Usage.InputTokens)
            .Append(" tokens_out=").Append(t.Usage.OutputTokens)
            .Append(" cache_read=").Append(t.Usage.CacheReadTokens);
        if (t.Cost is { } cost)
            sb.Append(" cost=").Append(cost.Total.ToString("F4", CultureInfo.InvariantCulture));
        if (t.FinishReason.Kind is { } kind)
            sb.Append(" finish=").Append(kind);
        return sb.ToString();
    }

    /// <summary>取在途模型调用时长（毫秒，单调墙钟差）：读并清除单槽；无在途调用返回 null。</summary>
    private long? TakeDuration(DateTimeOffset completedAt)
    {
        lock (_lock)
        {
            if (_lastModelCall is not { } call)
                return null;
            _lastModelCall = null;
            return (long)Math.Max(0, (completedAt - call.StartedAt).TotalMilliseconds);
        }
    }

    /// <summary>把多行 / 连续空白折叠成单行；超长截断（日志只做可扫视时间线，完整文本在会话 JSONL）。</summary>
    private static string Collapse(string text)
    {
        var collapsed = string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return collapsed.Length <= MaxFieldLength ? collapsed : collapsed[..MaxFieldLength] + "…";
    }

    /// <summary>写一行：持锁、守卫（已释放 / 无 writer 则丢弃）、按日轮转、逐行 flush（掉电安全）。</summary>
    private void WriteLine(LogLevel level, string message, long? durationMs)
    {
        lock (_lock)
        {
            if (_disposed || _writer is null)
                return;
            WriteLineCore(level, message, durationMs);
        }
    }

    /// <summary>写一行内核（调用方持锁，不做守卫）：轮转 + format + 写 + flush；IO 失败静默丢弃当行。</summary>
    private void WriteLineCore(LogLevel level, string message, long? durationMs)
    {
        var now = _options.Clock();
        // 按日轮转：日期键变化就重开文件（写前比对，次日首行正确落新文件）。
        var key = now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (key != _fileKey)
        {
            try
            {
                OpenWriter(now);
            }
            catch (Exception)
            {
                return;   // 轮转失败：本次放弃，下一行再试
            }
            if (_writer is null)
                return;
        }

        var line = $"[{now:yyyy-MM-dd HH:mm:ss.fff}] [{level.ToString().ToUpperInvariant()}] {message}";
        if (durationMs is { } ms)
            line += $" duration_ms={ms}";
        line = line.TrimEnd();

        try
        {
            _writer.WriteLine(line);
            _writer.Flush();
        }
        catch (Exception)
        {
            // 写失败（磁盘满 / 被删）：占位丢弃。下一行仍会尝试，不重试风暴。
        }
    }

    /// <summary>打开（或按日轮转重开）当日文件。调用方持锁；失败抛给调用方处理。</summary>
    private void OpenWriter(DateTimeOffset now)
    {
        _writer?.Dispose();   // 轮转：先关旧文件
        _writer = null;

        var key = now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var dir = Path.Combine(_options.RootDirectory, "logs");
        Directory.CreateDirectory(dir);
        var file = Path.Combine(dir, $"di-{key}.log");
        _writer = new StreamWriter(
            new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), Utf8NoBom);
        _fileKey = key;
    }
}