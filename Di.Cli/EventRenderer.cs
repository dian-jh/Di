using Core.AgentLoop;

namespace Di.Cli;

/// <summary>
/// 把 <see cref="AgentLoopEvent"/> 与 <see cref="AgentResult"/> 渲染成终端文本。
/// 事件由总线 pull 消费后逐条渲染；最终回答单独渲染。
/// </summary>
public sealed class EventRenderer
{
    private readonly TextWriter _output;

    public EventRenderer(TextWriter output) => _output = output;

    public void Render(AgentLoopEvent evt)
    {
        switch (evt)
        {
            case AgentLoopEvent.TurnCompleted t:
                _output.WriteLine($"  ── 第 {t.Iteration} 轮思考完成  in:{t.Usage.InputTokens} out:{t.Usage.OutputTokens}");
                break;
            case AgentLoopEvent.ToolStarted s:
                _output.WriteLine($"  → 调用工具 {s.Call.Name}({s.Call.Arguments})");
                break;
            case AgentLoopEvent.ToolCompleted c:
                _output.WriteLine($"  ← {(c.IsError ? "ERROR" : "ok")}  {c.Observation}");
                break;
            case AgentLoopEvent.RunFailed f:
                _output.WriteLine($"  ✗ 失败: [{f.Failure.Code}] {f.Failure.Message}");
                break;
        }
    }

    public void RenderResult(AgentResult result)
    {
        _output.WriteLine();
        _output.WriteLine("════ 回答 ════");
        _output.WriteLine(result.Answer);
        _output.WriteLine($"（{result.StopReason} · {result.Iterations} 轮 · tokens: {result.Usage}）");
    }
}
