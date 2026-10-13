using System.Text.Json.Nodes;
using Common.Events;
using Core.AgentLoop;
using Core.Llm;

namespace Di.Tests;

/// <summary>
/// 针对 <see cref="IInterruptSignal"/> 软停止语义的单元测试（docs/modules/interrupt.md）。
///
/// 一个回合是"模型相位 ⇄ 工具相位"的交替循环，软停止只在两个<b>相位边界</b>被观测：
/// <list type="bullet">
/// <item><b>B0/B2</b>（进入模型相位前）：未开始的工作不启动 → 不再发起模型调用。</item>
/// <item><b>B1</b>（执行工具前）：不再执行任何工具，但仍保留模型已产出的可见文本。</item>
/// </list>
/// 已开始的相位（在途模型调用 / 正在执行的工具）不被打断 —— 这是软停止与硬取消的关键差别。
/// </summary>
public sealed class ReActInterruptTests
{
    private const string SystemPrompt = "test system prompt";

    private static AgentLoopOptions Options(int maxIterations = 8) =>
        new() { SystemPrompt = SystemPrompt, MaxIterations = maxIterations };

    private static AgentRequest Request(IToolExecutor executor) => new()
    {
        UserMessage = "hello",
        ToolExecutor = executor,
    };

    private static ModelResponse Response(string? text = null, params ToolCallBlock[] toolCalls) => new()
    {
        Message = ChatMessage.Assistant(text, toolCalls: toolCalls),
        FinishReason = toolCalls.Length > 0 ? new FinishReason.ToolCalls() : new FinishReason.Stop(),
        Usage = TokenUsage.Zero,
    };

    [Fact]
    public async Task StopRequested_BeforeFirstModelCall_ReturnsInterruptedWithoutCallingModel()
    {
        var signal = new FakeInterruptSignal { IsStopRequested = true };
        var model = new FakeChatModel();
        var executor = new FakeToolExecutor(_ => "x");
        var loop = new ReAct(model, Options(), interrupt: signal);

        var result = await loop.RunAsync(Request(executor));

        Assert.Equal(AgentStopReason.Interrupted, result.StopReason);
        Assert.Empty(model.Requests);          // 未发起模型调用
        Assert.Empty(executor.Calls);          // 未执行工具
        Assert.Equal(0, result.Iterations);
        Assert.Equal(string.Empty, result.Answer);
    }

    [Fact]
    public async Task StopRequested_AfterModelProducedToolCalls_DoesNotExecuteTools()
    {
        // 场景 B1：模型已回复（文本 + 工具调用），中断在"执行工具之前"到达 → 一个工具都不跑。
        var signal = new FakeInterruptSignal();
        var model = new FakeChatModel();
        model.Enqueue(_ =>
        {
            signal.IsStopRequested = true;   // 模型刚产出，软停止请求到达
            return Response("let me check", new ToolCallBlock("c1", "echo", "{}"));
        });
        var executor = new FakeToolExecutor(_ => "should not run");
        var loop = new ReAct(model, Options(), interrupt: signal);

        var result = await loop.RunAsync(Request(executor));

        Assert.Equal(AgentStopReason.Interrupted, result.StopReason);
        Assert.Empty(executor.Calls);                    // 工具不执行
        Assert.Single(model.Requests);                   // 不再发起下一次模型调用
        Assert.Equal("let me check", result.Answer);     // 模型可见文本保留为答案
        Assert.Equal(1, result.Iterations);
    }

    [Fact]
    public async Task StopRequested_AfterToolBatch_StopsBeforeNextModelCall()
    {
        // 场景 B2：工具已跑完，中断在"下一次模型调用之前"到达 → 记录工具结果后停下。
        var signal = new FakeInterruptSignal();
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("need data", new ToolCallBlock("c1", "echo", "{}")));
        var executor = new FakeToolExecutor(_ =>
        {
            signal.IsStopRequested = true;   // 工具执行期间请求到达 → 本批跑完后停
            return "tool result";
        });
        var loop = new ReAct(model, Options(), interrupt: signal);

        var result = await loop.RunAsync(Request(executor));

        Assert.Equal(AgentStopReason.Interrupted, result.StopReason);
        Assert.Single(executor.Calls);                   // 已开始的工具跑完
        Assert.Single(model.Requests);                   // 不再发起下一次模型调用
        // trajectory: [user, assistant(toolcall), tool] —— 工具结果保留在轨迹里
        Assert.Equal(3, result.Trajectory.Count);
        Assert.Equal("tool result", ((ToolResultMessage)result.Trajectory[2]).Content);
    }

    [Fact]
    public async Task StopRequested_ButModelReturnedPlainAnswer_ReturnsAnswerNotInterrupted()
    {
        // 顺序保证：无工具调用的回答是正常收敛，优先于 B1 检查（模型已经给出完整答案，没什么可中断）。
        var signal = new FakeInterruptSignal();
        var model = new FakeChatModel();
        model.Enqueue(_ =>
        {
            signal.IsStopRequested = true;
            return Response("final answer");
        });
        var loop = new ReAct(model, Options(), interrupt: signal);

        var result = await loop.RunAsync(Request(new FakeToolExecutor(_ => "x")));

        Assert.Equal(AgentStopReason.Answer, result.StopReason);
        Assert.Equal("final answer", result.Answer);
    }

    [Fact]
    public async Task InterruptedResult_CarriesUsageAndCostAccumulatedSoFar()
    {
        var signal = new FakeInterruptSignal();
        var model = new FakeChatModel();
        model.Enqueue(_ =>
        {
            signal.IsStopRequested = true;   // 在第一次模型调用后请求停止
            return new ModelResponse
            {
                Message = ChatMessage.Assistant(null, toolCalls: [new ToolCallBlock("c1", "echo", "{}")]),
                FinishReason = new FinishReason.ToolCalls(),
                Usage = new TokenUsage(10, 5),
                Cost = new UsageCost(1.0, 0.5, 0, 0),
            };
        });
        var loop = new ReAct(model, Options(), interrupt: signal);

        var result = await loop.RunAsync(Request(new FakeToolExecutor(_ => "x")));

        Assert.Equal(AgentStopReason.Interrupted, result.StopReason);
        Assert.Equal(new TokenUsage(10, 5), result.Usage);   // 中断前花掉的用量照常上报
        Assert.Equal(new UsageCost(1.0, 0.5, 0, 0), result.Cost);
    }

    [Fact]
    public async Task Interrupted_PublishesInterruptedEvent()
    {
        var bus = new InMemoryEventBus();
        var observer = new RecordingObserver();
        bus.Subscribe(observer);
        var signal = new FakeInterruptSignal { IsStopRequested = true };
        var loop = new ReAct(new FakeChatModel(), Options(), bus, interrupt: signal);

        await loop.RunAsync(Request(new FakeToolExecutor(_ => "x")));

        Assert.Single(observer.Events.OfType<AgentLoopEvent.Interrupted>());
    }

    [Fact]
    public async Task NoSignal_NeverInterrupts()
    {
        // 可空 = 不可软中断：既有行为不受影响（回归保护）。
        var model = new FakeChatModel();
        model.Enqueue(_ => Response("ok"));
        var loop = new ReAct(model, Options());

        var result = await loop.RunAsync(Request(new FakeToolExecutor(_ => "x")));

        Assert.Equal(AgentStopReason.Answer, result.StopReason);
    }
}
