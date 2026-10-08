using Core.AgentLoop;

namespace Di.Cli;

/// <summary>
/// 把 <see cref="AgentLoopEvent"/> 与 <see cref="AgentResult"/> 渲染成终端文本。
/// <see cref="AgentLoopEvent.TextDelta"/> 以追加方式实时写出（流式），其余事件各自成行；
/// 最终回答在流式下就是最后一段增量文本，故 <see cref="RenderResult"/> 只打印元信息脚注，
/// 仅在 <see cref="AgentStopReason.FinalOutputTool"/>（答案未流式）时补打印答案块。
/// </summary>
public sealed class EventRenderer
{
    private readonly TextWriter _output;
    private readonly bool _useAnsi;
    private bool _lineOpen;   // 当前行是否有未换行的流式文本
    private bool _statusShown;   // 是否正在显示"进行中"状态行（等待首个内容将其擦除）

    public EventRenderer(TextWriter output, bool useAnsi = true)
    {
        _output = output ?? throw new ArgumentNullException(nameof(output));
        _useAnsi = useAnsi;
    }

    /// <summary>
    /// 显示一条"进行中"状态行（如"正在请求模型…"）。首个事件/结果渲染时会被擦除。
    /// 请求可能在几秒内无任何事件（网络延迟、模型思考），没有这行用户会以为程序卡死。
    /// </summary>
    public void ShowStatus(string text)
    {
        _output.WriteLine(text);
        _output.Flush();
        _statusShown = true;
    }

    /// <summary>
    /// 清除状态行。正常路径由 <see cref="Render"/> / <see cref="RenderResult"/> 自动调用；
    /// 回合异常路径（runner 直接抛错）需要显式调用，避免"正在请求模型…"残留。
    /// 非 ANSI（输出重定向）时状态行已自带换行，无需清行。
    /// </summary>
    public void ClearStatus()
    {
        if (!_statusShown)
            return;
        _statusShown = false;
        if (_useAnsi)
            _output.Write("\r\x1b[2K");   // 回到行首 + 整行清空，覆盖状态行
    }

    public void Render(AgentLoopEvent evt)
    {
        ClearStatus();
        switch (evt)
        {
            case AgentLoopEvent.TextDelta d:
                _output.Write(d.Delta);
                _lineOpen = true;
                _output.Flush();   // 实时渲染：立即推送到终端
                break;
            case AgentLoopEvent.TurnCompleted t:
                CloseLine();
                _output.WriteLine($"  ── 第 {t.Iteration} 轮思考完成  in:{t.Usage.InputTokens} out:{t.Usage.OutputTokens}");
                break;
            case AgentLoopEvent.ToolStarted s:
                CloseLine();
                _output.WriteLine($"  → 调用工具 {s.Call.Name}({s.Call.Arguments})");
                break;
            case AgentLoopEvent.ToolCompleted c:
                _output.WriteLine($"  ← {(c.IsError ? "ERROR" : "ok")}  {c.Observation}");
                break;
            case AgentLoopEvent.RunFailed f:
                CloseLine();
                _output.WriteLine($"  ✗ 失败: [{f.Failure.Code}] {f.Failure.Message}");
                break;
        }
    }

    public void RenderResult(AgentResult result)
    {
        ClearStatus();
        CloseLine();
        _output.WriteLine();

        if (result.StopReason == AgentStopReason.FinalOutputTool)
        {
            // 最终输出工具的答案（参数）未经流式渲染，这里打印。
            _output.WriteLine("════ 回答 ════");
            _output.WriteLine(result.Answer);
        }

        _output.WriteLine($"（{result.StopReason} · {result.Iterations} 轮 · tokens: {result.Usage}）");
    }

    /// <summary>若有未换行的流式文本，先补一个换行，避免后续行贴在一起。</summary>
    private void CloseLine()
    {
        if (_lineOpen)
        {
            _output.WriteLine();
            _lineOpen = false;
        }
    }
}
