using System.Runtime.CompilerServices;
using Common.Events;
using Core.AgentLoop;
using Core.Llm;
using Core.Skills;
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

    [Fact]
    public async Task RunAsync_AccumulatesHistoryAcrossTurns()
    {
        var model = new FakeChatModel();
        var runner = new AgentRunner(
            _ => model,
            new FakeToolExecutor(),
            new AgentLoopOptions { SystemPrompt = "sys" },
            new InMemoryEventBus());

        await runner.RunAsync("第一问");
        await runner.RunAsync("第二问");

        Assert.Equal(2, model.Requests.Count);
        var second = model.Requests[1];
        // [system, user第一问, assistant, user第二问] —— 上一回合轨迹被带回
        Assert.Equal(4, second.Messages.Count);
        Assert.Equal("第一问", ChatMessageExtensions.GetText(second.Messages[1]));
        Assert.Equal("第二问", ChatMessageExtensions.GetText(second.Messages[3]));
    }

    [Fact]
    public async Task RunAsync_TrimsHistoryToMaxTurns()
    {
        var model = new FakeChatModel();
        var runner = new AgentRunner(
            _ => model,
            new FakeToolExecutor(),
            new AgentLoopOptions { SystemPrompt = "sys" },
            new InMemoryEventBus(),
            maxHistoryTurns: 2);

        for (var i = 1; i <= 5; i++)
            await runner.RunAsync($"问{i}");

        // 请求 = 记忆(最近 2 轮) + 当前回合：问3、问4 来自记忆，问5 是当前；问1、问2 已被裁掉。
        var last = model.Requests[^1];
        var userTexts = last.Messages.OfType<UserMessage>().Select(ChatMessageExtensions.GetText).ToArray();
        Assert.Equal(["问3", "问4", "问5"], userTexts);
    }

    [Fact]
    public async Task ResetHistory_ClearsAccumulatedMemory()
    {
        var model = new FakeChatModel();
        var runner = new AgentRunner(
            _ => model,
            new FakeToolExecutor(),
            new AgentLoopOptions { SystemPrompt = "sys" },
            new InMemoryEventBus());

        await runner.RunAsync("第一问");
        runner.ResetHistory();
        await runner.RunAsync("第二问");

        var last = model.Requests[^1];
        var userTexts = last.Messages.OfType<UserMessage>().Select(ChatMessageExtensions.GetText).ToArray();
        Assert.Equal(["第二问"], userTexts);   // 记忆被清空，只有当前问
    }

    [Fact]
    public async Task RunAsync_WithActiveSkill_AppendsSkillToSystemContext()
    {
        var model = new FakeChatModel();
        var runner = new AgentRunner(
            _ => model,
            new FakeToolExecutor(),
            new AgentLoopOptions { SystemPrompt = "sys" },
            new InMemoryEventBus());

        runner.ActiveSkills =
        [
            new Skill { Name = "backend-tests", Description = "跑后端测试", Instructions = "先 dotnet build 再 dotnet test" },
        ];
        await runner.RunAsync("hi");

        var request = Assert.Single(model.Requests);
        var system = Assert.IsType<SystemMessage>(request.Messages[0]);
        Assert.Contains("backend-tests", system.Text);
        Assert.Contains("先 dotnet build 再 dotnet test", system.Text);
    }

    [Fact]
    public async Task RunAsync_WithMultipleActiveSkills_AppendsAllInOrder()
    {
        var model = new FakeChatModel();
        var runner = new AgentRunner(
            _ => model,
            new FakeToolExecutor(),
            new AgentLoopOptions { SystemPrompt = "sys" },
            new InMemoryEventBus());

        runner.ActiveSkills =
        [
            new Skill { Name = "a", Description = "d", Instructions = "指令 A" },
            new Skill { Name = "b", Description = "d", Instructions = "指令 B" },
        ];
        await runner.RunAsync("hi");

        var request = Assert.Single(model.Requests);
        var system = Assert.IsType<SystemMessage>(request.Messages[0]);
        var indexA = system.Text.IndexOf("指令 A", StringComparison.Ordinal);
        var indexB = system.Text.IndexOf("指令 B", StringComparison.Ordinal);
        Assert.True(indexA >= 0 && indexB >= 0);
        Assert.True(indexA < indexB, "多个 skill 应按 ActiveSkills 顺序注入");
    }

    [Fact]
    public async Task RunAsync_WithoutActiveSkill_DoesNotIncludeSkillContext()
    {
        var model = new FakeChatModel();
        var runner = new AgentRunner(
            _ => model,
            new FakeToolExecutor(),
            new AgentLoopOptions { SystemPrompt = "sys" },
            new InMemoryEventBus());

        await runner.RunAsync("hi");

        var request = Assert.Single(model.Requests);
        var system = Assert.IsType<SystemMessage>(request.Messages[0]);
        Assert.DoesNotContain("已激活 Skill", system.Text);
    }

    [Fact]
    public async Task RunAsync_WithWorkingDirectory_InjectsEnvironmentSnapshot()
    {
        var dir = Directory.CreateTempSubdirectory("di-runner-").FullName;
        try
        {
            var model = new FakeChatModel();
            var runner = new AgentRunner(
                _ => model,
                new FakeToolExecutor(),
                new AgentLoopOptions { SystemPrompt = "sys" },
                new InMemoryEventBus(),
                workingDirectory: dir);

            await runner.RunAsync("hi");

            var request = Assert.Single(model.Requests);
            var system = Assert.IsType<SystemMessage>(request.Messages[0]);
            Assert.Contains("sys", system.Text);
            Assert.Contains("工作目录", system.Text);
            Assert.Contains(dir, system.Text);
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { }
        }
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
