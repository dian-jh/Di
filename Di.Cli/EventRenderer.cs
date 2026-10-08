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
    private bool _lineOpen;   // 当前行是否有未换行的流式文本

    public EventRenderer(TextWriter output) => _output = output;

    public void Render(AgentLoopEvent evt)
    {
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
