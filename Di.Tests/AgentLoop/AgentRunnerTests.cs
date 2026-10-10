using System.Diagnostics;
using System.Runtime.CompilerServices;
using Common.Events;
using Core.AgentLoop;
using Core.Llm;
using Core.Skills;

namespace Di.Tests;

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
        Assert.Equal("sys", Assert.IsType<SystemMessage>(request.Messages[0]).Text);   // 稳定前缀独立
        var skillCtx = Assert.IsType<SystemMessage>(request.Messages[^1]);             // 激活 skill 置请求末尾
        Assert.Contains("backend-tests", skillCtx.Text);
        Assert.Contains("先 dotnet build 再 dotnet test", skillCtx.Text);
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
        var system = Assert.IsType<SystemMessage>(request.Messages[^1]);   // 激活 skill 置请求末尾
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
    public async Task RunAsync_WithSkills_AdvertisesAndAddsLoadSkillTool()
    {
        var model = new FakeChatModel();
        var skill = new Skill { Name = "backend-tests", Description = "运行并修复后端测试", Instructions = "body" };
        var runner = new AgentRunner(
            _ => model,
            new FakeToolExecutor(),
            new AgentLoopOptions { SystemPrompt = "sys" },
            new InMemoryEventBus(),
            skills: [skill]);

        await runner.RunAsync("hi");

        var request = Assert.Single(model.Requests);
        Assert.Equal("sys", Assert.IsType<SystemMessage>(request.Messages[0]).Text);
        var advertise = Assert.IsType<SystemMessage>(request.Messages[^1]);   // 广告块置请求末尾
        Assert.Contains("可用 skills", advertise.Text);
        Assert.Contains("backend-tests", advertise.Text);
        Assert.Contains("运行并修复后端测试", advertise.Text);
        Assert.Contains(request.Tools, t => t.Name == "load_skill");
    }

    [Fact]
    public async Task RunAsync_WithWorkingDirectory_InjectsSnapshotIntoHistory()
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
            Assert.Equal("sys", Assert.IsType<SystemMessage>(request.Messages[0]).Text);   // 稳定前缀独立
            // 环境快照进持久历史，位于 system prompt 之后、用户消息之前（不再每回合在请求末尾重复注入）。
            var snapshot = Assert.IsType<SystemMessage>(request.Messages[1]);
            Assert.Contains("工作目录", snapshot.Text);
            Assert.Contains(dir, snapshot.Text);
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { }
        }
    }

    [Fact]
    public async Task RunAsync_SnapshotUnchanged_NotReinjectedNextTurn()
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

            await runner.RunAsync("第一问");
            await runner.RunAsync("第二问");

            var second = model.Requests[1];
            // 快照内容未变：只在历史里出现一次，不重复注入。
            var snapshots = second.Messages.OfType<SystemMessage>()
                .Where(m => m.Text.Contains("工作目录")).ToList();
            Assert.Single(snapshots);
            // 布局 [0]=sys [1]=快照 [2]=第一问 —— 快照仍是历史首条，第二问直接跟在轨迹后面。
            Assert.Equal("第一问", ChatMessageExtensions.GetText(second.Messages[2]));
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { }
        }
    }

    [Fact]
    public async Task RunAsync_SnapshotChanged_AppendsUpdatedSnapshot()
    {
        if (FindGit() is null) return;   // 无 git 则跳过（与 Di.Tests 同款策略）
        var repo = InitGitRepo();
        try
        {
            var model = new FakeChatModel();
            var runner = new AgentRunner(
                _ => model,
                new FakeToolExecutor(),
                new AgentLoopOptions { SystemPrompt = "sys" },
                new InMemoryEventBus(),
                workingDirectory: repo);

            await runner.RunAsync("第一问");
            File.WriteAllText(Path.Combine(repo, "changed.txt"), "x");   // 让 git 状态发生变化
            await runner.RunAsync("第二问");

            var second = model.Requests[1];
            var snapshots = second.Messages.OfType<SystemMessage>()
                .Where(m => m.Text.Contains("工作目录")).ToList();
            Assert.Equal(2, snapshots.Count);                 // 旧快照 + 变化后的新快照
            Assert.Contains("changed.txt", snapshots[1].Text);   // 新快照带上未提交变更
        }
        finally
        {
            try { Directory.Delete(repo, recursive: true); } catch { }
        }
    }

    [Fact]
    public async Task RunAsync_SnapshotTrimmedFromHistory_ReinjectedNextTurn()
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
                workingDirectory: dir,
                maxHistoryTurns: 1);

            await runner.RunAsync("第一问");   // 快照进历史
            await runner.RunAsync("第二问");   // 历史裁剪到 1 回合，快照被裁掉
            await runner.RunAsync("第三问");   // 快照应重新注入

            var third = model.Requests[^1];
            Assert.Equal("sys", Assert.IsType<SystemMessage>(third.Messages[0]).Text);
            // 裁剪把旧快照裁出历史后，第三回合应重新注入（快照作为历史末尾的 system 消息存在）。
            Assert.Contains(third.Messages, m => m is SystemMessage s && s.Text.Contains("工作目录"));
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { }
        }
    }

    [Fact]
    public async Task ResetHistory_ReinjectsFreshSnapshot()
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

            await runner.RunAsync("第一问");
            runner.ResetHistory();
            await runner.RunAsync("第二问");

            var second = model.Requests[^1];
            // 重置后历史清空，快照重新作为首条历史注入。
            Assert.Equal("sys", Assert.IsType<SystemMessage>(second.Messages[0]).Text);
            Assert.Contains("工作目录", Assert.IsType<SystemMessage>(second.Messages[1]).Text);
        }
        finally
        {
            try { Directory.Delete(dir, recursive: true); } catch { }
        }
    }

    // ---- 工具：git 探测 / 临时仓库（与 Di.Tests/EnvironmentSnapshotTests 同款策略）----

    private static string? FindGit()
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo("git", "--version")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            p!.WaitForExit(5000);
            return p.ExitCode == 0 ? "git" : null;
        }
        catch
        {
            return null;
        }
    }

    private static string InitGitRepo()
    {
        var dir = Directory.CreateTempSubdirectory("di-git-").FullName;
        RunGit(dir, "init", "-q");
        RunGit(dir, "config", "user.name", "Test");
        RunGit(dir, "config", "user.email", "test@example.com");
        RunGit(dir, "commit", "--allow-empty", "-q", "-m", "init");
        return dir;
    }

    private static void RunGit(string dir, params string[] args)
    {
        using var p = Process.Start(new ProcessStartInfo("git", string.Join(' ', args.Select(a => a.Contains(' ') ? $"\"{a}\"" : a)))
        {
            WorkingDirectory = dir,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        })!;
        p.WaitForExit(20000);
        Assert.True(p.ExitCode == 0, $"git {string.Join(' ', args)} 失败: {p.StandardError.ReadToEnd()}");
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
