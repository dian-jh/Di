using Core.AgentLoop;
using Core.Llm;
using Di.Cli;

namespace Di.Cli.Tests;

/// <summary>
/// 针对 <see cref="EventRenderer"/> 的单元测试：每种事件渲染成稳定的终端文本。
/// </summary>
public sealed class EventRendererTests
{
    [Fact]
    public void Render_TurnCompleted_WritesIterationAndUsage()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);

        renderer.Render(new AgentLoopEvent.TurnCompleted(2, new TokenUsage(10, 5), Cost: null, new FinishReason.Stop()));

        var text = output.ToString();
        Assert.Contains("第 2 轮思考完成", text);
        Assert.Contains("in:10", text);
        Assert.Contains("out:5", text);
    }

    [Fact]
    public void Render_ToolStarted_WritesToolNameAndArguments()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);

        renderer.Render(new AgentLoopEvent.ToolStarted(new ToolCallBlock("c1", "add_numbers", """{"a":1,"b":2}""")));

        var text = output.ToString();
        Assert.Contains("调用工具 add_numbers", text);
        Assert.Contains(""""{"a":1,"b":2}"""", text);
    }

    [Fact]
    public void Render_ToolCompleted_WritesObservation()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);

        renderer.Render(new AgentLoopEvent.ToolCompleted(new ToolCallBlock("c1", "echo", "{}"), "result-ok", IsError: false));

        Assert.Contains("ok", output.ToString());
        Assert.Contains("result-ok", output.ToString());
    }

    [Fact]
    public void Render_ToolCompleted_Error_PrefixedWithError()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);

        renderer.Render(new AgentLoopEvent.ToolCompleted(new ToolCallBlock("c1", "boom", "{}"), "kaboom", IsError: true));

        var text = output.ToString();
        Assert.Contains("ERROR", text);
        Assert.Contains("kaboom", text);
    }

    [Fact]
    public void Render_RunFailed_WritesCodeAndMessage()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);

        renderer.Render(new AgentLoopEvent.RunFailed(new LlmFailure("no key", LlmErrorCodes.MissingCredential)));

        var text = output.ToString();
        Assert.Contains("失败", text);
        Assert.Contains(LlmErrorCodes.MissingCredential, text);
        Assert.Contains("no key", text);
    }

    [Fact]
    public void Render_ReasoningAndToolCallDeltas_AreSilentlyIgnored()
    {
        // M1：新增的增量事件由 TUI 消费；文本渲染器（statement switch）对未知 case 天然忽略，
        // 不得抛出、不得输出（否则会污染 headless/REPL 的既有输出）。
        var output = new StringWriter();
        var renderer = new EventRenderer(output);

        renderer.Render(new AgentLoopEvent.ReasoningDelta("思考中"));
        renderer.Render(new AgentLoopEvent.ToolCallDelta("c1", "echo", """{"x":1}"""));

        Assert.Equal(string.Empty, output.ToString());
    }

    [Fact]
    public void Render_TextDelta_AppendsTextAndClosesOnTurnCompleted()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);

        renderer.Render(new AgentLoopEvent.TextDelta("你"));
        renderer.Render(new AgentLoopEvent.TextDelta("好"));
        renderer.Render(new AgentLoopEvent.TurnCompleted(1, TokenUsage.Zero, Cost: null, new FinishReason.Stop()));

        var text = output.ToString();
        Assert.StartsWith("你好", text);   // 流式追加，不换行
        Assert.Contains("第 1 轮思考完成", text);
    }

    [Fact]
    public void RenderResult_AnswerCase_WritesFooterOnly_NoAnswerReprint()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);
        var result = new AgentResult
        {
            Answer = "答案是 42",   // 已流式渲染，不应重复打印
            Trajectory = [ChatMessage.User("hi")],
            Usage = new TokenUsage(7, 3),
            Iterations = 2,
            StopReason = AgentStopReason.Answer,
        };

        renderer.RenderResult(result);

        var text = output.ToString();
        Assert.DoesNotContain("答案是 42", text);
        Assert.Contains("Answer", text);
        Assert.Contains("2 轮", text);
    }

    [Fact]
    public void RenderResult_MaxIterations_WithAnswer_PrintsPartialAnswer()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);
        var result = new AgentResult
        {
            Answer = "已修复 fib，但还没跑完测试",
            Trajectory = [ChatMessage.User("hi")],
            Usage = new TokenUsage(7, 3),
            Iterations = 24,
            StopReason = AgentStopReason.MaxIterations,
        };

        renderer.RenderResult(result);

        var text = output.ToString();
        Assert.Contains("已达迭代上限", text);
        Assert.Contains("已修复 fib，但还没跑完测试", text);
        Assert.Contains("MaxIterations", text);
        Assert.Contains("24 轮", text);
    }

    [Fact]
    public void RenderResult_MaxIterations_EmptyAnswer_StillPrintsNotice()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);
        var result = new AgentResult
        {
            Answer = "",
            Trajectory = [ChatMessage.User("hi")],
            Usage = new TokenUsage(7, 3),
            Iterations = 8,
            StopReason = AgentStopReason.MaxIterations,
        };

        renderer.RenderResult(result);

        var text = output.ToString();
        Assert.Contains("已达迭代上限", text);
        Assert.Contains("MaxIterations", text);   // 即便无文本也有可见收尾
    }

    [Fact]
    public void Render_InterruptedEvent_WritesNotice()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);
        renderer.Render(new AgentLoopEvent.TextDelta("部分输出"));

        renderer.Render(new AgentLoopEvent.Interrupted());

        var text = output.ToString();
        Assert.StartsWith("部分输出", text);   // 先关闭未换行的流式文本，再另起一行
        Assert.Contains("已收到中断", text);
    }

    [Fact]
    public void RenderResult_Interrupted_WritesNotice_NoAnswerReprint()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);
        var result = new AgentResult
        {
            Answer = "部分输出",   // 已随流式事件显示，不应重复回显
            Trajectory = [ChatMessage.User("hi")],
            Usage = new TokenUsage(7, 3),
            Iterations = 1,
            StopReason = AgentStopReason.Interrupted,
        };

        renderer.RenderResult(result);

        var text = output.ToString();
        Assert.Contains("已中断", text);
        Assert.DoesNotContain("部分输出", text);
        Assert.Contains("Interrupted", text);   // 统计脚注含停止原因
    }

    [Fact]
    public void ShowStatus_WritesStatusLineWithNewline()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);

        renderer.ShowStatus("⟳ 思考中…");

        Assert.Equal("⟳ 思考中…" + Environment.NewLine, output.ToString());
    }

    [Fact]
    public void Render_AfterShowStatus_ErasesStatusLineThenAppendsContent()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);

        renderer.ShowStatus("⟳ 思考中…");
        renderer.Render(new AgentLoopEvent.TextDelta("你"));
        renderer.Render(new AgentLoopEvent.TextDelta("好"));

        Assert.Equal("⟳ 思考中…" + Environment.NewLine + "\r\x1b[2K你好", output.ToString());
    }

    [Fact]
    public void Render_AfterShowStatus_WithoutAnsi_ContinuesOnNewLine()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output, useAnsi: false);

        renderer.ShowStatus("⟳ 思考中…");
        renderer.Render(new AgentLoopEvent.TextDelta("你好"));

        Assert.Equal("⟳ 思考中…" + Environment.NewLine + "你好", output.ToString());
    }

    [Fact]
    public void RenderResult_AfterShowStatus_ErasesStatusLineBeforeFooter()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);
        var result = new AgentResult
        {
            Answer = "答案",   // 已流式渲染，不应重复打印
            Trajectory = [ChatMessage.User("hi")],
            Iterations = 2,
            StopReason = AgentStopReason.Answer,
        };

        renderer.ShowStatus("⟳ 思考中…");
        renderer.RenderResult(result);

        var text = output.ToString();
        Assert.StartsWith("⟳ 思考中…" + Environment.NewLine + "\r\x1b[2K", text);
        Assert.Contains("Answer", text);
        Assert.DoesNotContain("答案", text);
    }

    [Fact]
    public void ClearStatus_WithoutShownStatus_WritesNothing()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);

        renderer.ClearStatus();

        Assert.Equal(string.Empty, output.ToString());
    }

    [Fact]
    public void Render_TurnCompleted_WithCost_WritesCostSegment()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);

        renderer.Render(new AgentLoopEvent.TurnCompleted(2, new TokenUsage(10, 5), new UsageCost(1.0, 2.0, 0, 0), new FinishReason.Stop()));

        var text = output.ToString();
        Assert.Contains("in:10", text);
        Assert.Contains("cost:$3.000000", text);   // Total = 1.0 + 2.0
    }

    [Fact]
    public void RenderResult_WithCost_ShowsCostInFooter()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);
        var result = new AgentResult
        {
            Answer = "答案",
            Trajectory = [ChatMessage.User("hi")],
            Usage = new TokenUsage(7, 3),
            Iterations = 2,
            StopReason = AgentStopReason.Answer,
            Cost = new UsageCost(1.0, 2.0, 0, 0),
        };

        renderer.RenderResult(result);

        Assert.Contains("cost:$3.000000", output.ToString());
    }

    [Fact]
    public void RenderResult_NoCost_OmitsCostSegment()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);
        var result = new AgentResult
        {
            Answer = "答案",
            Trajectory = [ChatMessage.User("hi")],
            Usage = new TokenUsage(7, 3),
            Iterations = 2,
            StopReason = AgentStopReason.Answer,
        };

        renderer.RenderResult(result);

        Assert.DoesNotContain("cost:", output.ToString());
    }
}
