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
    public void RenderResult_WritesAnswerAndMetadata()
    {
        var output = new StringWriter();
        var renderer = new EventRenderer(output);
        var result = new AgentResult
        {
            Answer = "答案是 42",
            Trajectory = [ChatMessage.User("hi")],
            Usage = new TokenUsage(7, 3),
            Iterations = 2,
            StopReason = AgentStopReason.Answer,
        };

        renderer.RenderResult(result);

        var text = output.ToString();
        Assert.Contains("答案是 42", text);
        Assert.Contains(AgentStopReason.Answer.ToString(), text);
        Assert.Contains("2 轮", text);
    }
}
