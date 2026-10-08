using System.Runtime.CompilerServices;
using Common.Events;
using Core.AgentLoop;
using Core.Llm;
using Di.Cli;

namespace Di.Cli.Tests;

/// <summary>
/// 针对 <see cref="AgentRunner"/> 的单元测试：模型工厂按当前模型名解析模型，
/// ReAct 经共享总线发布循环事件。
/// </summary>
public sealed class AgentRunnerTests
{
    [Fact]
    public async Task RunAsync_UsesCurrentModel_AndReturnsResult()
    {
        var model = new FakeChatModel();
        var requestedModels = new List<string>();
        var runner = new AgentRunner(
            name =>
            {
                requestedModels.Add(name);
                return model;
            },
            new FakeToolExecutor(),
            new AgentLoopOptions { SystemPrompt = "sys" },
            new InMemoryEventBus());

        runner.CurrentModel = "deepseek-chat";
        var result = await runner.RunAsync("hi");

        Assert.Equal(["deepseek-chat"], requestedModels);
        Assert.Equal("hi", result.Answer);
        Assert.Equal(AgentStopReason.Answer, result.StopReason);
        var request = Assert.Single(model.Requests);
        Assert.Equal("sys", Assert.IsType<SystemMessage>(request.Messages[0]).Text);
    }

    [Fact]
    public async Task RunAsync_PublishesLoopEventsToBus()
    {
        var bus = new InMemoryEventBus();
        var observer = new RecordingHandler();
        bus.Subscribe(observer);
        var runner = new AgentRunner(_ => new FakeChatModel(), new FakeToolExecutor(), new AgentLoopOptions(), bus);

        await runner.RunAsync("hi");

        Assert.Single(observer.Events.OfType<AgentLoopEvent.TurnCompleted>());
    }

    private sealed class FakeChatModel : IChatModel
    {
        public List<ModelRequest> Requests { get; } = [];

        public Task<ModelResponse> CompleteAsync(ModelRequest request, CancellationToken cancellationToken = default)
        {
            Requests.Add(request);
            return Task.FromResult(new ModelResponse
            {
                Message = ChatMessage.Assistant("hi"),
                FinishReason = new FinishReason.Stop(),
                Usage = TokenUsage.Zero,
            });
        }

        public async IAsyncEnumerable<ModelEvent> StreamAsync(
            ModelRequest request, [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            // AgentRunner 走流式路径：合成单个 Completed 事件。
            yield return new ModelEvent.Completed(await CompleteAsync(request, cancellationToken));
        }
    }

    private sealed class FakeToolExecutor : IToolExecutor
    {
        public Task<string> ExecuteAsync(ToolCallBlock call, CancellationToken cancellationToken = default)
            => Task.FromResult("ok");
    }

    private sealed class RecordingHandler : IEventHandler<AgentLoopEvent>
    {
        public List<AgentLoopEvent> Events { get; } = [];

        public Task HandleAsync(AgentLoopEvent evt, CancellationToken cancellationToken = default)
        {
            Events.Add(evt);
            return Task.CompletedTask;
        }
    }
}
