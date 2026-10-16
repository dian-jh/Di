using Common.Events;
using Core.AgentLoop;
using Core.ContextManagement;
using Core.Llm;
using Core.Tools;

namespace Di.Tests.ContextManagement;

/// <summary>
/// 组合根接线级测试（验收场景 1，docs/context-compression.md §9）：走
/// AgentRunner → ReAct → CompactingExecutor → 假内层执行器 + 真实 ArtifactStore +
/// InputBudgetTracker（B_current 共享 holder）的<b>真实执行路径</b>，证明生产配置
/// （1M 窗口、默认预算 soft≈616k）下"长会话 + 工具输出暴增"确实触发 L1 摘要 + 落盘，
/// 而不是单元测试的假装配。关键：1.5M 字符（≈375k token）的结果单独够不到 soft，
/// 只有 B_current（上回合 1M 字符 ≈250k token 入历史）参与预测才越线——即 holder 接线
/// 是 L1 起效的必要条件（M1 验收的死角回归）。
/// </summary>
public sealed class CompactingWiringTests
{
    [Fact]
    public async Task SameTurn_MultipleToolResults_UseCurrentTrajectoryBudget()
    {
        var policy = new BudgetPolicy(100_000, outputReserveTokens: 0, marginRatio: 0);
        var tracker = new InputBudgetTracker();
        var artifacts = new RecordingArtifacts();
        var full = new string('X', 160_000);
        var executor = new CompactingExecutor(new FakeInner(_ => full), policy, artifacts,
            () => tracker.CurrentTokens);
        var model = new FakeChatModel();
        model.Enqueue(_ => new ModelResponse
        {
            Message = ChatMessage.Assistant(new string('A', 40_000), toolCalls:
                [new ToolCallBlock("c1", "read_file", "{}"), new ToolCallBlock("c2", "read_file", "{}")]),
            FinishReason = new FinishReason.ToolCalls(),
            Usage = TokenUsage.Zero,
        });
        model.Enqueue(_ => new ModelResponse
        {
            Message = ChatMessage.Assistant("done"),
            FinishReason = new FinishReason.Stop(),
            Usage = TokenUsage.Zero,
        });
        var runner = new AgentRunner(_ => model, executor, new AgentLoopOptions(), new InMemoryEventBus(),
            budgetPolicy: policy, budgetTracker: tracker);

        await runner.RunAsync(new string('U', 40_000));

        var results = model.Requests[^1].Messages.OfType<ToolResultMessage>().ToArray();
        Assert.Equal(full, results[0].Content);
        Assert.Contains("已保存到", results[1].Content);
        Assert.Equal(1, artifacts.Writes);
    }

    private sealed class RecordingArtifacts : IArtifactStore
    {
        public int Writes { get; private set; }
        public string Write(string toolName, string content)
        {
            Writes++;
            return "artifact.txt";
        }
    }

    [Fact]
    public async Task LongSession_WithToolOutputSpike_SummarizesAndSpills_OnRealExecutionPath()
    {
        var root = Path.Combine(Path.GetTempPath(), "di-cm-wiring", Guid.NewGuid().ToString("N"));
        try
        {
            var policy = new BudgetPolicy(1_000_000);   // 生产默认：1M 窗口，soft ≈ 616k
            var tracker = new InputBudgetTracker();
            var store = new ArtifactStore(root);
            var full = new string('Y', 1_500_000);      // ≈375k token：单点暴增，但单独 < soft
            var executor = new CompactingExecutor(new FakeInner(_ => full), policy, store,
                currentInputTokens: () => tracker.CurrentTokens);

            var model = new FakeChatModel();
            // 回合 1：巨大回答（1M 字符 ≈250k token 入持久记忆 → holder 累计）。
            model.Enqueue(_ => new ModelResponse
            {
                Message = ChatMessage.Assistant(new string('A', 1_000_000)),
                FinishReason = new FinishReason.Stop(),
                Usage = TokenUsage.Zero,
            });
            // 回合 2 迭代 1：模型要求 read_file → 执行器返回 1.5M 字符。
            model.Enqueue(_ => new ModelResponse
            {
                Message = ChatMessage.Assistant(text: null, toolCalls: [new ToolCallBlock("c1", "read_file", "{}")]),
                FinishReason = new FinishReason.ToolCalls(),
                Usage = TokenUsage.Zero,
            });
            // 回合 2 迭代 2：最终答案。
            model.Enqueue(_ => new ModelResponse
            {
                Message = ChatMessage.Assistant("完成"),
                FinishReason = new FinishReason.Stop(),
                Usage = TokenUsage.Zero,
            });

            var runner = new AgentRunner(
                _ => model,
                executor,
                new AgentLoopOptions { SystemPrompt = "sys" },
                new InMemoryEventBus(),
                budgetPolicy: policy,
                budgetTracker: tracker);

            await runner.RunAsync("第一问");
            Assert.True(tracker.CurrentTokens >= 250_000);   // holder 接入了跨回合累计

            var result = await runner.RunAsync("第二问");

            Assert.Equal("完成", result.Answer);
            Assert.Equal(3, model.Requests.Count);   // [回合1] + [回合2迭代1, 回合2迭代2]

            // 工具结果消息：摘要 + artifactRef，而非完整输出。
            var toolResult = model.Requests[2].Messages.OfType<ToolResultMessage>().Single();
            Assert.Contains("已保存到", toolResult.Content);
            Assert.Contains(store.ArtifactsDirectory, toolResult.Content);
            Assert.Contains("省略", toolResult.Content);
            Assert.DoesNotContain(new string('Y', 100_000), toolResult.Content);   // 不是 1.5M 全文
            Assert.True(toolResult.Content.Length < full.Length);

            // 真实落盘：artifacts 目录恰好一个文件，往返 = 完整输出。
            var files = Directory.GetFiles(store.ArtifactsDirectory, "*.txt");
            var file = Assert.Single(files);
            Assert.Equal(full, await File.ReadAllTextAsync(file));
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task FreshSession_SmallToolOutput_StaysInline_OnRealExecutionPath()
    {
        var root = Path.Combine(Path.GetTempPath(), "di-cm-wiring", Guid.NewGuid().ToString("N"));
        try
        {
            var policy = new BudgetPolicy(1_000_000);
            var tracker = new InputBudgetTracker();
            var store = new ArtifactStore(root);
            var executor = new CompactingExecutor(new FakeInner(_ => "小输出"), policy, store,
                currentInputTokens: () => tracker.CurrentTokens);

            var model = new FakeChatModel();
            model.Enqueue(_ => new ModelResponse
            {
                Message = ChatMessage.Assistant(text: null, toolCalls: [new ToolCallBlock("c1", "read_file", "{}")]),
                FinishReason = new FinishReason.ToolCalls(),
                Usage = TokenUsage.Zero,
            });
            model.Enqueue(_ => new ModelResponse
            {
                Message = ChatMessage.Assistant("完成"),
                FinishReason = new FinishReason.Stop(),
                Usage = TokenUsage.Zero,
            });

            var runner = new AgentRunner(
                _ => model,
                executor,
                new AgentLoopOptions { SystemPrompt = "sys" },
                new InMemoryEventBus(),
                budgetPolicy: policy,
                budgetTracker: tracker);

            var result = await runner.RunAsync("第一问");

            Assert.Equal("完成", result.Answer);
            var toolResult = model.Requests[^1].Messages.OfType<ToolResultMessage>().Single();
            Assert.Equal("小输出", toolResult.Content);   // 未越线 → 原样进轨迹
            Assert.False(Directory.Exists(store.ArtifactsDirectory));   // 无任何落盘
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }

    private sealed class FakeInner : IToolExecutor
    {
        private readonly Func<ToolCallBlock, string> _handler;
        public FakeInner(Func<ToolCallBlock, string> handler) => _handler = handler;

        public Task<string> ExecuteAsync(ToolCallBlock call, CancellationToken cancellationToken = default)
            => Task.FromResult(_handler(call));
    }
}
