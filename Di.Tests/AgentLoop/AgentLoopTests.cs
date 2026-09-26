using System.Text.Json.Nodes;
using Core.AgentLoop;
using Core.Llm;

namespace Di.Tests;

/// <summary>
/// 针对 <see cref="Core.AgentLoop.AgentLoop"/> 的单元测试。
/// 用 fake 模型覆盖：主路径、工具循环、失败转观察、预算上限、上下文组装、校验缝。
/// </summary>
public sealed class AgentLoopTests
{
    private const string SystemPrompt = "test system prompt";

    private static AgentLoopOptions Options(int maxIterations = 8) =>
        new() { SystemPrompt = SystemPrompt, MaxIterations = maxIterations };

    private static AgentRequest Request(
        string userMessage = "hello",
        IToolExecutor? executor = null,
        IToolValidator? validator = null,
        IReadOnlyList<ChatTool>? tools = null) => new()
    {
        UserMessage = userMessage,
        ToolExecutor = executor ?? new FakeToolExecutor(_ => ""),
        Validator = validator,
        Tools = tools,
    };

    private static ModelResponse Response(string? text = null, params ToolCallBlock[] toolCalls) => new()
    {
        Message = ChatMessage.Assistant(text, toolCalls: toolCalls),
        FinishReason = toolCalls.Length > 0 ? new FinishReason.ToolCalls() : new FinishReason.Stop(),
        Usage = TokenUsage.Zero,
    };

    private static ChatTool Tool(string name) =>
        ChatTool.Create(name, "test tool", (JsonObject)JsonNode.Parse("""{"type":"object","properties":{}}""")!);

    [Fact]
    public async Task RunAsync_ModelReturnsNoToolCall_ReturnsAnswerWithTrajectory()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("final answer"));
        var executor = new FakeToolExecutor(_ => "");
        var loop = new AgentLoop(model, Options());

        var result = await loop.RunAsync(Request(executor: executor));

        Assert.Equal(AgentStopReason.Answer, result.StopReason);
        Assert.Equal("final answer", result.Answer);
        Assert.Equal(1, result.Iterations);
        Assert.Empty(executor.Calls);
        Assert.Equal(2, result.Trajectory.Count);   // [user, assistant]
        Assert.IsType<UserMessage>(result.Trajectory[0]);
        Assert.IsType<AssistantMessage>(result.Trajectory[1]);
    }

    [Fact]
    public async Task RunAsync_ContextIsStablePrefixThenTrajectory()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("ok"));
        var loop = new AgentLoop(model, Options());

        await loop.RunAsync(Request(userMessage: "hi"));

        var request = Assert.Single(model.Requests);
        Assert.Equal(2, request.Messages.Count);    // 只有 [system, user]，没有别的
        var system = Assert.IsType<SystemMessage>(request.Messages[0]);
        Assert.Equal(SystemPrompt, system.Text);
        var user = Assert.IsType<UserMessage>(request.Messages[1]);
        Assert.Equal("hi", ChatMessageExtensions.GetText(user));
    }

    [Fact]
    public async Task RunAsync_NoSystemPrompt_ContextIsTrajectoryOnly()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("ok"));
        var loop = new AgentLoop(model, new AgentLoopOptions { SystemPrompt = "", MaxIterations = 8 });

        await loop.RunAsync(Request());

        var request = Assert.Single(model.Requests);
        Assert.All(request.Messages, m => Assert.IsNotType<SystemMessage>(m));
    }

    [Fact]
    public async Task RunAsync_ToolsArePassedToModel()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("ok"));
        var tools = new[] { Tool("echo") };
        var loop = new AgentLoop(model, Options());

        await loop.RunAsync(Request(tools: tools));

        var request = Assert.Single(model.Requests);
        Assert.Same(tools, request.Tools);
    }

    [Fact]
    public async Task RunAsync_ToolCallThenAnswer_ExecutesToolAppendsObservationAndLoops()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("need data", new ToolCallBlock("call_1", "echo", """{"x":1}""")));
        model.Enqueue(_ => Response("done"));
        var executor = new FakeToolExecutor(call => $"result for {call.Name}");
        var loop = new AgentLoop(model, Options());

        var result = await loop.RunAsync(Request(executor: executor, tools: [Tool("echo")]));

        Assert.Equal(AgentStopReason.Answer, result.StopReason);
        Assert.Equal("done", result.Answer);
        Assert.Equal(2, result.Iterations);
        Assert.Equal(2, model.Requests.Count);
        var call = Assert.Single(executor.Calls);
        Assert.Equal("echo", call.Name);
        // trajectory: [user, assistant(toolcall), tool, assistant(answer)]
        Assert.Equal(4, result.Trajectory.Count);
        var tool = Assert.IsType<ToolResultMessage>(result.Trajectory[2]);
        Assert.Equal("call_1", tool.ToolCallId);
        Assert.Equal("result for echo", tool.Content);
    }

    [Fact]
    public async Task RunAsync_MultipleToolCallsInOneTurn_AllExecutedAndAppended()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("need both",
            new ToolCallBlock("c1", "echo", """{"v":1}"""),
            new ToolCallBlock("c2", "echo", """{"v":2}""")));
        model.Enqueue(_ => Response("summed"));
        var executor = new FakeToolExecutor(call => call.Arguments);
        var loop = new AgentLoop(model, Options());

        var result = await loop.RunAsync(Request(executor: executor));

        Assert.Equal(2, executor.Calls.Count);
        Assert.Equal(5, result.Trajectory.Count);   // [user, assistant, tool, tool, assistant]
        Assert.IsType<ToolResultMessage>(result.Trajectory[2]);
        Assert.IsType<ToolResultMessage>(result.Trajectory[3]);
        Assert.Equal(AgentStopReason.Answer, result.StopReason);
    }

    [Fact]
    public async Task RunAsync_ToolExecutionThrows_TurnsIntoErrorObservationAndContinues()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("will call", new ToolCallBlock("c1", "boom", "{}")));
        model.Enqueue(_ => Response("recovered"));
        var executor = new FakeToolExecutor(_ => throw new InvalidOperationException("kaboom"));
        var loop = new AgentLoop(model, Options());

        var result = await loop.RunAsync(Request(executor: executor));

        Assert.Equal(AgentStopReason.Answer, result.StopReason);
        Assert.Equal(2, result.Iterations);
        var tool = Assert.IsType<ToolResultMessage>(result.Trajectory[2]);
        Assert.Contains("error", tool.Content);
        Assert.Contains("kaboom", tool.Content);
    }

    [Fact]
    public async Task RunAsync_ExceedsMaxIterations_StopsWithBudgetExhausted()
    {
        var model = new FakeChatModel();
        model.Fallback(_ => Response("still working", new ToolCallBlock($"c{model.Requests.Count}", "echo", "{}")));
        var executor = new FakeToolExecutor(call => "x");
        var loop = new AgentLoop(model, Options(maxIterations: 3));

        var result = await loop.RunAsync(Request(executor: executor));

        Assert.Equal(AgentStopReason.MaxIterations, result.StopReason);
        Assert.Equal(3, result.Iterations);
        Assert.Equal(3, executor.Calls.Count);
    }

    [Fact]
    public async Task RunAsync_AccumulatesUsageAcrossModelCalls()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => ToolCallResponse(new TokenUsage(10, 5)));
        model.Enqueue(_ => ResponseWithUsage("b", new TokenUsage(20, 7)));
        var executor = new FakeToolExecutor(call => "x");
        var loop = new AgentLoop(model, Options());

        var result = await loop.RunAsync(Request(executor: executor));

        Assert.Equal(2, model.Requests.Count);
        Assert.Equal(30, result.Usage.InputTokens);
        Assert.Equal(12, result.Usage.OutputTokens);
    }

    [Fact]
    public async Task RunAsync_ValidatorIsInvokedBeforeExecution()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("x", new ToolCallBlock("c1", "echo", "{}")));
        model.Enqueue(_ => Response("done"));
        var executor = new FakeToolExecutor(call => "ok");
        var validator = new RecordingValidator();
        var loop = new AgentLoop(model, Options());

        await loop.RunAsync(Request(executor: executor, validator: validator));

        var validated = Assert.Single(validator.Calls);
        Assert.Equal("echo", validated.Name);
        Assert.Single(executor.Calls);
    }

    [Fact]
    public async Task RunAsync_ValidatorRejects_PropagatesAndAbortsRun()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("x", new ToolCallBlock("c1", "echo", "{}")));
        var executor = new FakeToolExecutor(call => "ok");
        var loop = new AgentLoop(model, Options());

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            loop.RunAsync(Request(executor: executor, validator: new RejectingValidator())));
    }

    private static ModelResponse ResponseWithUsage(string text, TokenUsage usage) => new()
    {
        Message = ChatMessage.Assistant(text),
        FinishReason = new FinishReason.Stop(),
        Usage = usage,
    };

    private static ModelResponse ToolCallResponse(TokenUsage usage) => new()
    {
        Message = ChatMessage.Assistant(null, toolCalls: [new ToolCallBlock("c1", "echo", "{}")]),
        FinishReason = new FinishReason.ToolCalls(),
        Usage = usage,
    };
}
