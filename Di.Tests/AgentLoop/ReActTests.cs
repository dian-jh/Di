using System.Text.Json.Nodes;
using Common.Events;
using Core.AgentLoop;
using Core.Llm;

namespace Di.Tests;

/// <summary>
/// 针对 <see cref="Core.AgentLoop.ReAct"/> 的单元测试。
/// 用 fake 模型覆盖：主路径、工具循环、失败转观察、预算上限、最终输出工具、
/// 错误归一化、上下文组装、校验缝、观察事件。
/// </summary>
public sealed class ReActTests
{
    private const string SystemPrompt = "test system prompt";

    private static AgentLoopOptions Options(int maxIterations = 8, string? finalOutputTool = null) =>
        new() { SystemPrompt = SystemPrompt, MaxIterations = maxIterations, FinalOutputTool = finalOutputTool };

    private static AgentRequest Request(
        string userMessage = "hello",
        IToolExecutor? executor = null,
        IToolValidator? validator = null,
        IReadOnlyList<ChatTool>? tools = null,
        string? systemContext = null,
        IReadOnlyList<ChatMessage>? history = null) => new()
    {
        UserMessage = userMessage,
        ToolExecutor = executor ?? new FakeToolExecutor(_ => ""),
        Validator = validator,
        Tools = tools,
        SystemContext = systemContext,
        History = history,
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
        var loop = new ReAct(model, Options());

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
        var loop = new ReAct(model, Options());

        await loop.RunAsync(Request(userMessage: "hi"));

        var request = Assert.Single(model.Requests);
        Assert.Equal(2, request.Messages.Count);    // 只有 [system, user]，没有别的
        var system = Assert.IsType<SystemMessage>(request.Messages[0]);
        Assert.Equal(SystemPrompt, system.Text);
        var user = Assert.IsType<UserMessage>(request.Messages[1]);
        Assert.Equal("hi", ChatMessageExtensions.GetText(user));
    }

    [Fact]
    public async Task RunAsync_History_IsPrependedBeforeCurrentUserMessage()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("ok"));
        var loop = new ReAct(model, Options());

        var history = new ChatMessage[] { ChatMessage.User("之前的问题"), ChatMessage.Assistant("之前的回答") };
        await loop.RunAsync(Request(userMessage: "现在的问题", history: history));

        var request = Assert.Single(model.Requests);
        Assert.Equal(4, request.Messages.Count);   // [system, user旧, assistant旧, user新]
        Assert.Equal("之前的问题", ChatMessageExtensions.GetText(request.Messages[1]));
        Assert.Equal("之前的回答", ChatMessageExtensions.GetText(request.Messages[2]));
        Assert.Equal("现在的问题", ChatMessageExtensions.GetText(request.Messages[3]));
    }

    [Fact]
    public async Task RunAsync_History_IncludedInTrajectory_AndExposedOnResult()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("ok"));
        var loop = new ReAct(model, Options());

        var history = new ChatMessage[] { ChatMessage.User("a"), ChatMessage.Assistant("ra") };
        var result = await loop.RunAsync(Request(userMessage: "b", history: history));

        Assert.Equal(4, result.Trajectory.Count);   // [user a, assistant ra, user b, assistant ok]
        Assert.Equal("a", ChatMessageExtensions.GetText(result.Trajectory[0]));
        Assert.Equal("b", ChatMessageExtensions.GetText(result.Trajectory[2]));
        Assert.Same(history, result.History);       // 会话日志据此跳过已记录的历史
    }

    [Fact]
    public async Task RunAsync_History_ThenToolLoop_AccumulatesFullTrajectory()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("need", new ToolCallBlock("c1", "echo", "{}")));
        model.Enqueue(_ => Response("done"));
        var executor = new FakeToolExecutor(call => "r");
        var loop = new ReAct(model, Options());

        var history = new ChatMessage[] { ChatMessage.User("旧"), ChatMessage.Assistant("旧答") };
        var result = await loop.RunAsync(Request(executor: executor, history: history));

        // [user旧, assistant旧答, user新, assistant(toolcall), tool, assistant done]
        Assert.Equal(6, result.Trajectory.Count);
        Assert.Equal("r", ((ToolResultMessage)result.Trajectory[4]).Content);
        Assert.Same(history, result.History);
    }

    [Fact]
    public async Task RunAsync_NoSystemPrompt_ContextIsTrajectoryOnly()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("ok"));
        var loop = new ReAct(model, new AgentLoopOptions { SystemPrompt = "", MaxIterations = 8 });

        await loop.RunAsync(Request());

        var request = Assert.Single(model.Requests);
        Assert.All(request.Messages, m => Assert.IsNotType<SystemMessage>(m));
    }

    [Fact]
    public async Task RunAsync_SystemContext_IsMergedIntoSystemMessage()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("ok"));
        var loop = new ReAct(model, Options());

        await loop.RunAsync(Request(systemContext: "## 环境\n- 工作目录: /tmp/x"));

        var request = Assert.Single(model.Requests);
        Assert.Equal(2, request.Messages.Count);   // [system, user]，system 仍是单条
        var system = Assert.IsType<SystemMessage>(request.Messages[0]);
        Assert.Contains(SystemPrompt, system.Text);
        Assert.Contains("## 环境", system.Text);
        Assert.Contains("/tmp/x", system.Text);
    }

    [Fact]
    public async Task RunAsync_SystemContextWithoutSystemPrompt_IsSystemMessage()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("ok"));
        var loop = new ReAct(model, new AgentLoopOptions { SystemPrompt = "", MaxIterations = 8 });

        await loop.RunAsync(Request(systemContext: "snapshot only"));

        var request = Assert.Single(model.Requests);
        var system = Assert.IsType<SystemMessage>(request.Messages[0]);
        Assert.Equal("snapshot only", system.Text);
    }

    [Fact]
    public async Task RunAsync_ToolsArePassedToModel()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("ok"));
        var tools = new[] { Tool("echo") };
        var loop = new ReAct(model, Options());

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
        var loop = new ReAct(model, Options());

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
        var loop = new ReAct(model, Options());

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
        var loop = new ReAct(model, Options());

        var result = await loop.RunAsync(Request(executor: executor));

        Assert.Equal(AgentStopReason.Answer, result.StopReason);
        Assert.Equal(2, result.Iterations);
        var tool = Assert.IsType<ToolResultMessage>(result.Trajectory[2]);
        Assert.Contains("error executing tool", tool.Content);
        Assert.Contains("kaboom", tool.Content);
    }

    [Fact]
    public async Task RunAsync_ExceedsMaxIterations_StopsAndDoesNotExecuteToolsOnFinalTurn()
    {
        var model = new FakeChatModel();
        model.Fallback(_ => Response("still working", new ToolCallBlock($"c{model.Requests.Count}", "echo", "{}")));
        var executor = new FakeToolExecutor(call => "x");
        var loop = new ReAct(model, Options(maxIterations: 3));

        var result = await loop.RunAsync(Request(executor: executor));

        Assert.Equal(AgentStopReason.MaxIterations, result.StopReason);
        Assert.Equal(3, result.Iterations);
        // 前两轮各执行 1 次，第三轮预算耗尽不执行
        Assert.Equal(2, executor.Calls.Count);
    }

    [Fact]
    public async Task RunAsync_FinalOutputTool_ReturnsArgumentsAsAnswerWithoutExecuting()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("finishing", new ToolCallBlock("f1", "finish", """{"answer":"42"}""")));
        var executor = new FakeToolExecutor(call => "should not run");
        var loop = new ReAct(model, Options(finalOutputTool: "finish"));

        var result = await loop.RunAsync(Request(executor: executor));

        Assert.Equal(AgentStopReason.FinalOutputTool, result.StopReason);
        Assert.Equal("""{"answer":"42"}""", result.Answer);
        Assert.Equal(1, result.Iterations);
        Assert.Empty(executor.Calls);
    }

    [Fact]
    public async Task RunAsync_FinalOutputTool_IsHonoredEvenOnLastIteration()
    {
        var model = new FakeChatModel();
        model.Fallback(_ => Response("finishing", new ToolCallBlock($"c{model.Requests.Count}", "finish", "{}")));
        var executor = new FakeToolExecutor(call => "x");
        var loop = new ReAct(model, Options(maxIterations: 2, finalOutputTool: "finish"));

        var result = await loop.RunAsync(Request(executor: executor));

        Assert.Equal(AgentStopReason.FinalOutputTool, result.StopReason);
        Assert.Empty(executor.Calls);
    }

    [Fact]
    public async Task RunAsync_NonRetryableModelError_ReturnsCleanErrorResult()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => throw new LlmException("missing api key", LlmErrorCodes.MissingCredential));
        var loop = new ReAct(model, Options());

        var result = await loop.RunAsync(Request());

        Assert.Equal(AgentStopReason.Error, result.StopReason);
        Assert.NotNull(result.Failure);
        Assert.Equal(LlmErrorCodes.MissingCredential, result.Failure.Code);
        Assert.Empty(result.Answer);
    }

    [Fact]
    public async Task RunAsync_RetryableModelError_PropagatesToCaller()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => throw new LlmException("rate limited", LlmErrorCodes.RateLimited));
        var loop = new ReAct(model, Options());

        await Assert.ThrowsAsync<LlmException>(() => loop.RunAsync(Request()));
    }

    [Fact]
    public async Task RunAsync_AccumulatesUsageAcrossModelCalls()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => ToolCallResponse(new TokenUsage(10, 5)));
        model.Enqueue(_ => ResponseWithUsage("b", new TokenUsage(20, 7)));
        var executor = new FakeToolExecutor(call => "x");
        var loop = new ReAct(model, Options());

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
        var loop = new ReAct(model, Options());

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
        var loop = new ReAct(model, Options());

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            loop.RunAsync(Request(executor: executor, validator: new RejectingValidator())));
    }

    [Fact]
    public async Task RunAsync_ObserverReceivesTurnAndToolEvents()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("need data", new ToolCallBlock("c1", "echo", "{}")));
        model.Enqueue(_ => Response("done"));
        var executor = new FakeToolExecutor(call => "ok");
        var (loop, observer) = LoopWithObserver(model);

        await loop.RunAsync(Request(executor: executor));

        Assert.Equal(4, observer.Events.Count);
        Assert.Equal(2, observer.Events.OfType<AgentLoopEvent.TurnCompleted>().Count());
        var started = Assert.Single(observer.Events.OfType<AgentLoopEvent.ToolStarted>());
        Assert.Equal("echo", started.Call.Name);
        var completed = Assert.Single(observer.Events.OfType<AgentLoopEvent.ToolCompleted>());
        Assert.False(completed.IsError);
        Assert.Equal("ok", completed.Observation);
    }

    [Fact]
    public async Task RunAsync_ObserverReceivesToolErrorEvent()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("x", new ToolCallBlock("c1", "echo", "{}")));
        model.Enqueue(_ => Response("recovered"));
        var executor = new FakeToolExecutor(_ => throw new InvalidOperationException("kaboom"));
        var (loop, observer) = LoopWithObserver(model);

        var result = await loop.RunAsync(Request(executor: executor));

        Assert.Equal(AgentStopReason.Answer, result.StopReason);
        var failed = Assert.Single(observer.Events.OfType<AgentLoopEvent.ToolCompleted>());
        Assert.True(failed.IsError);
        Assert.Contains("kaboom", failed.Observation);
    }

    [Fact]
    public async Task RunAsync_ObserverReceivesRunFailedOnNonRetryableError()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => throw new LlmException("no key", LlmErrorCodes.MissingCredential));
        var (loop, observer) = LoopWithObserver(model);

        var result = await loop.RunAsync(Request());

        Assert.Equal(AgentStopReason.Error, result.StopReason);
        var runFailed = Assert.Single(observer.Events.OfType<AgentLoopEvent.RunFailed>());
        Assert.Equal(LlmErrorCodes.MissingCredential, runFailed.Failure.Code);
    }

    [Fact]
    public async Task RunAsync_PublishesTurnAndToolEventsToBus()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("need data", new ToolCallBlock("c1", "echo", "{}")));
        model.Enqueue(_ => Response("done"));
        var executor = new FakeToolExecutor(call => "ok");
        var (loop, observer) = LoopWithObserver(model);

        await loop.RunAsync(Request(executor: executor, tools: [Tool("echo")]));

        Assert.Equal(4, observer.Events.Count);
        Assert.IsType<AgentLoopEvent.TurnCompleted>(observer.Events[0]);
        Assert.IsType<AgentLoopEvent.ToolStarted>(observer.Events[1]);
        Assert.IsType<AgentLoopEvent.ToolCompleted>(observer.Events[2]);
        Assert.IsType<AgentLoopEvent.TurnCompleted>(observer.Events[3]);
    }

    [Fact]
    public async Task RunAsync_BaseConsumerReceivesFullTurnInOrder()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("need data", new ToolCallBlock("c1", "echo", "{}")));
        model.Enqueue(_ => Response("done"));
        var executor = new FakeToolExecutor(call => "x");
        var bus = new InMemoryEventBus();
        using var consumer = bus.CreateConsumer<AgentLoopEvent>();
        var loop = new ReAct(model, Options(), bus);

        var result = await loop.RunAsync(Request(executor: executor, tools: [Tool("echo")]));

        var events = new List<AgentLoopEvent>();
        while (consumer.TryRead() is { } e)
            events.Add(e);
        Assert.Equal(4, events.Count);   // TurnCompleted → ToolStarted → ToolCompleted → TurnCompleted
        Assert.Equal(AgentStopReason.Answer, result.StopReason);
    }

    [Fact]
    public async Task RunAsync_PublishesRunFailedOnNonRetryableError()
    {
        var model = new FakeChatModel();
        model.Enqueue(_ => throw new LlmException("no key", LlmErrorCodes.MissingCredential));
        var (loop, observer) = LoopWithObserver(model);

        var result = await loop.RunAsync(Request());

        Assert.Equal(AgentStopReason.Error, result.StopReason);
        var runFailed = Assert.Single(observer.Events.OfType<AgentLoopEvent.RunFailed>());
        Assert.Equal(LlmErrorCodes.MissingCredential, runFailed.Failure.Code);
    }

    [Fact]
    public void AgentLoopEvent_IsEvent_WithIdAndCreatedAt()
    {
        var evt = new AgentLoopEvent.TurnCompleted(1, TokenUsage.Zero, new FinishReason.Stop());

        Assert.IsAssignableFrom<Event>(evt);
        Assert.NotEqual(Guid.Empty, evt.Id);
        Assert.True(evt.CreatedAt > DateTimeOffset.UnixEpoch);
    }

    [Fact]
    public async Task RunStreamingAsync_EmitsTextDeltaEventsAndReturnsAnswer()
    {
        var model = new FakeChatModel();
        model.EnqueueStream(_ => StreamOf(
            new ModelEvent.TextDelta("你"),
            new ModelEvent.TextDelta("好"),
            CompletedResponse("你好", new TokenUsage(10, 5))));
        var (loop, observer) = LoopWithObserver(model);

        var result = await loop.RunStreamingAsync(Request());

        Assert.Equal("你好", result.Answer);
        Assert.Equal(AgentStopReason.Answer, result.StopReason);
        var deltas = observer.Events.OfType<AgentLoopEvent.TextDelta>().Select(d => d.Delta);
        Assert.Equal(new[] { "你", "好" }, deltas);
        var turn = Assert.Single(observer.Events.OfType<AgentLoopEvent.TurnCompleted>());
        Assert.Equal(new TokenUsage(10, 5), turn.Usage);
    }

    [Fact]
    public async Task RunStreamingAsync_StreamWithToolCall_ContinuesLoop()
    {
        var model = new FakeChatModel();
        model.EnqueueStream(_ => StreamOf(
            new ModelEvent.TextDelta("查一下"),
            new ModelEvent.Completed(new ModelResponse
            {
                Message = ChatMessage.Assistant(null, toolCalls: [new ToolCallBlock("c1", "echo", "{}")]),
                FinishReason = new FinishReason.ToolCalls(),
                Usage = TokenUsage.Zero,
            })));
        model.EnqueueStream(_ => StreamOf(
            new ModelEvent.Completed(new ModelResponse
            {
                Message = ChatMessage.Assistant("完成"),
                FinishReason = new FinishReason.Stop(),
                Usage = TokenUsage.Zero,
            })));
        var executor = new FakeToolExecutor(call => "x");
        var (loop, observer) = LoopWithObserver(model);

        var result = await loop.RunStreamingAsync(Request(executor: executor, tools: [Tool("echo")]));

        Assert.Equal("完成", result.Answer);
        Assert.Equal(2, result.Iterations);
        Assert.Single(observer.Events.OfType<AgentLoopEvent.ToolStarted>());
        Assert.Single(observer.Events.OfType<AgentLoopEvent.ToolCompleted>());
        Assert.Single(observer.Events.OfType<AgentLoopEvent.TextDelta>());
    }

    private static async IAsyncEnumerable<ModelEvent> StreamOf(params ModelEvent[] events)
    {
        foreach (var evt in events)
            yield return evt;
    }

    private static ModelEvent.Completed CompletedResponse(string text, TokenUsage? usage = null) => new(new ModelResponse
    {
        Message = ChatMessage.Assistant(text),
        FinishReason = new FinishReason.Stop(),
        Usage = usage ?? TokenUsage.Zero,
    });

    /// <summary>创建订阅了 RecordingObserver 的总线，并把 ReAct 接到总线上。</summary>
    private static (ReAct Loop, RecordingObserver Observer) LoopWithObserver(FakeChatModel model, AgentLoopOptions? options = null)
    {
        var bus = new InMemoryEventBus();
        var observer = new RecordingObserver();
        bus.Subscribe(observer);
        return (new ReAct(model, options ?? Options(), bus), observer);
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
