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

        renderer.Render(new AgentLoopEvent.TurnCompleted(2, new TokenUsage(10, 5), new FinishReason.Stop()));

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
    public void Render_TextDelta_AppendsTextAndClosesOnTurnCompleted()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);

        renderer.Render(new AgentLoopEvent.TextDelta("你"));
        renderer.Render(new AgentLoopEvent.TextDelta("好"));
        renderer.Render(new AgentLoopEvent.TurnCompleted(1, TokenUsage.Zero, new FinishReason.Stop()));

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
    public void RenderResult_FinalOutputToolCase_PrintsAnswerBlock()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);
        var result = new AgentResult
        {
            Answer = """{"a":1}""",   // 最终输出工具的参数即答案，未经流式渲染，需打印
            Trajectory = [ChatMessage.User("hi")],
            Iterations = 1,
            StopReason = AgentStopReason.FinalOutputTool,
        };

        renderer.RenderResult(result);

        var text = output.ToString();
        Assert.Contains(""""{"a":1}"""", text);
        Assert.Contains("FinalOutputTool", text);
    }
}
