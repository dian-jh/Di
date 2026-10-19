using Common.Events;
using Core.AgentLoop;
using Core.ContextManagement;
using Core.Llm;

namespace Di.Tests.ContextManagement;

/// <summary>
/// M2 验收（验收场景 2，docs/context-compression.md §9）：AgentRunner 跨回合记忆
/// 从"每轮丢最旧"升级为预算制——注入 BudgetPolicy 后以 soft 水位线（B_input × SoftRatio，
/// 已扣输出/安全预留）为历史预算，与 L1 同源同一窗口口径；未注入时退回旧
/// "窗口 × HistoryBudgetRatio" 路径（现有行为不变）。同时验证 InputBudgetTracker
/// （B_current 共享 holder）被 AgentRunner 每回合写入估算。
/// </summary>
public sealed class AgentRunnerBudgetTrimmingTests
{
    private const int Window = 1_000;

    private static BudgetPolicy Policy() => new(Window, marginRatio: 0, outputReserveTokens: 0);

    /// <summary>单回合成本 = 1(user) + 99(assistant 396 字符) = 100 token。</summary>
    private static void EnqueueHundredTokenTurn(FakeChatModel model) =>
        model.Enqueue(_ => new ModelResponse
        {
            Message = ChatMessage.Assistant(new string('x', 396)),
            FinishReason = new FinishReason.Stop(),
            Usage = TokenUsage.Zero,
        });

    /// <summary>默认回答（1 token）入队，供对话回合消耗。</summary>
    private static void EnqueueTinyTurn(FakeChatModel model) =>
        model.Enqueue(_ => new ModelResponse
        {
            Message = ChatMessage.Assistant("hi"),
            FinishReason = new FinishReason.Stop(),
            Usage = TokenUsage.Zero,
        });

    [Fact]
    public async Task BudgetPolicy_TrimsHistoryBySoftThreshold()
    {
        var model = new FakeChatModel();
        var runner = new AgentRunner(
            _ => model, new FakeToolExecutor(_ => ""),
            new AgentLoopOptions { SystemPrompt = "sys" },
            new InMemoryEventBus(),
            budgetPolicy: Policy());

        // 甲 200t + 乙 300t + 丙 400t + 3 个 user ≈ 903t > 700 soft → 丢最旧直到 ≤700（仅剩丙）。
        model.Enqueue(_ => new ModelResponse { Message = ChatMessage.Assistant(new string('x', 800)), FinishReason = new FinishReason.Stop(), Usage = TokenUsage.Zero });
        await runner.RunAsync("甲");
        model.Enqueue(_ => new ModelResponse { Message = ChatMessage.Assistant(new string('x', 1200)), FinishReason = new FinishReason.Stop(), Usage = TokenUsage.Zero });
        await runner.RunAsync("乙");
        model.Enqueue(_ => new ModelResponse { Message = ChatMessage.Assistant(new string('x', 1600)), FinishReason = new FinishReason.Stop(), Usage = TokenUsage.Zero });
        await runner.RunAsync("丙");
        EnqueueTinyTurn(model);
        await runner.RunAsync("丁");

        var last = model.Requests[^1];
        var userTexts = last.Messages.OfType<UserMessage>().Select(ChatMessageExtensions.GetText).ToArray();
        Assert.Equal(["丙", "丁"], userTexts);
    }

    [Fact]
    public async Task BudgetPolicy_KeepsHistory_WhileUnderSoft()
    {
        var model = new FakeChatModel();
        var runner = new AgentRunner(
            _ => model, new FakeToolExecutor(_ => ""),
            new AgentLoopOptions { SystemPrompt = "sys" },
            new InMemoryEventBus(),
            budgetPolicy: Policy());

        EnqueueTinyTurn(model);
        await runner.RunAsync("甲");
        EnqueueTinyTurn(model);
        await runner.RunAsync("乙");
        EnqueueTinyTurn(model);
        await runner.RunAsync("丙");
        EnqueueTinyTurn(model);
        await runner.RunAsync("丁");

        var last = model.Requests[^1];
        var userTexts = last.Messages.OfType<UserMessage>().Select(ChatMessageExtensions.GetText).ToArray();
        Assert.Equal(["甲", "乙", "丙", "丁"], userTexts);   // 少数字 token ≪ 700 → 不裁剪
    }

    [Fact]
    public async Task BudgetPolicy_KeepsAtLeastMostRecentTurn_WhenSingleTurnOverBudget()
    {
        var model = new FakeChatModel();
        var runner = new AgentRunner(
            _ => model, new FakeToolExecutor(_ => ""),
            new AgentLoopOptions { SystemPrompt = "sys" },
            new InMemoryEventBus(),
            budgetPolicy: Policy());

        model.Enqueue(_ => new ModelResponse { Message = ChatMessage.Assistant(new string('X', 10_000)), FinishReason = new FinishReason.Stop(), Usage = TokenUsage.Zero });
        await runner.RunAsync("甲");   // 单回合 ≈ 2501t > 700，但 userCount=1 → 全保留
        EnqueueTinyTurn(model);
        var paused = await runner.RunAsync("乙");

        Assert.Equal(AgentStopReason.ContextLimit, paused.StopReason);
        Assert.Single(model.Requests);
        Assert.Contains(paused.Trajectory, m => m is UserMessage && m.GetText() == "甲");
        Assert.Contains(paused.Trajectory, m => m is AssistantMessage && m.GetText().Length == 10_000);
        Assert.Contains(paused.Trajectory, m => m is UserMessage && m.GetText() == "乙");
    }

    [Fact]
    public async Task BudgetPolicy_TrimsLessAggressively_ThanFlatRatioPath()
    {
        // 预算制（soft 700）比旧"窗口 × 0.5"（500）保留更多回合：B_input 把可输入量定在
        // 更贴近真实的位置，且预留被显式扣出（不压榨输出/安全空间）。
        var budgeted = new FakeChatModel();
        var policyRunner = new AgentRunner(
            _ => budgeted, new FakeToolExecutor(_ => ""),
            new AgentLoopOptions { SystemPrompt = "sys" },
            new InMemoryEventBus(),
            budgetPolicy: Policy());
        for (var i = 1; i <= 7; i++)
        {
            EnqueueHundredTokenTurn(budgeted);
            await policyRunner.RunAsync($"a{i}");   // 每次请求均按完整上下文估算裁剪历史。
        }
        Assert.Equal(5, budgeted.Requests[^1].Messages.OfType<UserMessage>().Count());

        var flat = new FakeChatModel();
        var legacyRunner = new AgentRunner(
            _ => flat, new FakeToolExecutor(_ => ""),
            new AgentLoopOptions { SystemPrompt = "sys", HistoryBudgetRatio = 0.5 },
            new InMemoryEventBus(),
            maxHistoryTurns: 99,
            contextWindowProvider: _ => Window);   // 旧路径预算 = 0.5 × 1000 = 500
        for (var i = 1; i <= 7; i++)
        {
            EnqueueHundredTokenTurn(flat);
            await legacyRunner.RunAsync($"a{i}");   // 旧比例路径也按实际请求内容估算。
        }
        // 请求中保留的 user 数量由完整上下文预算决定。
        Assert.Equal(4, flat.Requests[^1].Messages.OfType<UserMessage>().Count());
    }

    [Fact]
    public async Task NoPolicy_FallsBackToLegacyRatioPath_AndStillTrims()
    {
        // 未注入 BudgetPolicy → 旧路径（窗口 × ratio）照常工作：现有 AgentRunnerTests 契约不变。
        var model = new FakeChatModel();
        var runner = new AgentRunner(
            _ => model, new FakeToolExecutor(_ => ""),
            new AgentLoopOptions { SystemPrompt = "sys", HistoryBudgetRatio = 0.5 },
            new InMemoryEventBus(),
            maxHistoryTurns: 99,
            contextWindowProvider: _ => Window);
        for (var i = 1; i <= 7; i++)
        {
            EnqueueHundredTokenTurn(model);
            await runner.RunAsync($"a{i}");
        }
        // 请求中保留的 user 数量由完整上下文预算决定（旧路径）。
        Assert.Equal(4, model.Requests[^1].Messages.OfType<UserMessage>().Count());
    }

    [Fact]
    public async Task NoBudgetAndNoMaxHistoryTurns_KeepsFullHistory()
    {
        // 产品决策（docs/context-compression.md §9）：删除"默认保留最近 10 轮"轮数启发式。
        // 无预算（未注入 BudgetPolicy、窗口解析失败）时仅当显式传 maxHistoryTurns > 0 才轮数兜底；
        // 不传（默认 0）= 无轮数上限，历史原样保留。跑 12 轮超过旧默认 10，可判别启发式已移除。
        var model = new FakeChatModel();
        var runner = new AgentRunner(
            _ => model, new FakeToolExecutor(_ => ""),
            new AgentLoopOptions { SystemPrompt = "sys" },
            new InMemoryEventBus());   // 无 budgetPolicy、无 contextWindowProvider、maxHistoryTurns 默认 0

        var expected = new string[12];
        for (var i = 0; i < 12; i++)
        {
            expected[i] = $"问{i + 1}";
            EnqueueTinyTurn(model);
            await runner.RunAsync(expected[i]);
        }

        var last = model.Requests[^1];
        var userTexts = last.Messages.OfType<UserMessage>().Select(ChatMessageExtensions.GetText).ToArray();
        Assert.Equal(expected, userTexts);   // 12 轮全部保留（旧默认 10 会裁掉最旧 2 轮）
    }

    [Fact]
    public async Task Runner_ReportsEstimatedHistoryToTracker_AndResets()
    {
        var tracker = new InputBudgetTracker();
        var model = new FakeChatModel();
        var runner = new AgentRunner(
            _ => model, new FakeToolExecutor(_ => ""),
            new AgentLoopOptions { SystemPrompt = "sys" },
            new InMemoryEventBus(),
            budgetTracker: tracker);

        model.Enqueue(_ => new ModelResponse { Message = ChatMessage.Assistant(new string('X', 800)), FinishReason = new FinishReason.Stop(), Usage = TokenUsage.Zero });
        await runner.RunAsync("甲");

        Assert.Equal(201, tracker.CurrentTokens);   // user 甲(1) + assistant 800 字符(200)

        runner.ResetHistory();
        Assert.Equal(0, tracker.CurrentTokens);     // 重置记忆 → holder 归零
    }
}
