using Common.Events;
using Core.AgentLoop;
using Core.Llm;
using Core.Skills;

namespace Di.Cli.Tests;

/// <summary>
/// CLI 层测试替身（与 Di.Tests/AgentRunnerTests 的 fakes 同思路：真实事件总线 + 假驱动）：
/// <list type="bullet">
/// <item><see cref="FakeLlm"/> —— 假模型目录，只回答 <see cref="ILlmService.ListModels"/>。</item>
/// <item><see cref="FakeRunner"/> —— 假会话驱动：发布 TextDelta + TurnCompleted，结果可配置（usage/cost/stopReason）。</item>
/// <item><see cref="ThrowingRunner"/> —— RunAsync 直接抛异常（模拟凭据缺失 / 传输故障）。</item>
/// <item><see cref="ErrorRunner"/> —— 返回 StopReason.Error 的结果（模拟不可重试的模型错误）。</item>
/// </list>
/// </summary>
public sealed class FakeLlm : ILlmService
{
    private readonly IReadOnlyList<LlmModelInfo> _models;

    public FakeLlm(IReadOnlyList<LlmModelInfo> models) => _models = models;

    public IReadOnlyList<LlmModelInfo> ListModels(string? provider = null)
        => provider is null ? _models : _models.Where(m => m.Provider == provider).ToList();

    public IAdapterRegistration RegisterAdapter(string[] providers, ChatAdapter adapter)
        => throw new NotSupportedException();
    public IReadOnlyList<LlmProviderInfo> ListProviders() => [];
    public UsageCost? CalculateCost(string provider, string model, TokenUsage usage) => null;
    public Task<bool> CheckAuthAsync(string provider, CancellationToken cancellationToken = default)
        => Task.FromResult(true);
    public Task<LlmResolvedModelInfo> ResolveModelAsync(string provider, string model, CancellationToken cancellationToken = default)
        => throw new NotSupportedException();
    public IAsyncEnumerable<StreamChunk> StreamAsync(GenerateOptions options)
        => throw new NotSupportedException();
    public event Action? AdaptersUpdated { add { } remove { } }
}

public sealed class FakeRunner : IAgentRunner
{
    public IEventBus? Bus { get; set; }

    public string CurrentModel { get; set; } = "deepseek-flash";

    public IReadOnlyList<Skill> ActiveSkills { get; set; } = [];

    public IInterruptSignal? InterruptSignal { get; set; }

    public List<string> Messages { get; } = [];

    public TokenUsage Usage { get; set; } = new(10, 20);

    public UsageCost? Cost { get; set; }

    public AgentStopReason StopReason { get; set; } = AgentStopReason.Answer;

    public LlmFailure? Failure { get; set; }

    public void ResetHistory() { }

    public async Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
    {
        Messages.Add(userMessage);
        // 模拟 ReAct 流式：先发文本增量，再发回合完成事件（headless 文本模式依赖事件流渲染）。
        if (Bus is not null)
        {
            await Bus.PublishAsync(new AgentLoopEvent.TextDelta($"回答: {userMessage}"));
            await Bus.PublishAsync(new AgentLoopEvent.TurnCompleted(1, Usage, Cost: Cost, new FinishReason.Stop()));
        }
        return new AgentResult
        {
            Answer = $"回答: {userMessage}",
            Trajectory = [ChatMessage.User(userMessage)],
            Iterations = 1,
            Usage = Usage,
            Cost = Cost,
            StopReason = StopReason,
            Failure = Failure,
        };
    }
}

/// <summary>RunAsync 直接抛异常（模拟凭据缺失 / 传输故障等不可恢复错误）。</summary>
public sealed class ThrowingRunner : IAgentRunner
{
    public string CurrentModel { get; set; } = "deepseek-flash";
    public IReadOnlyList<Skill> ActiveSkills { get; set; } = [];

    public IInterruptSignal? InterruptSignal { get; set; }
    public Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
        => throw new InvalidOperationException("boom");
    public void ResetHistory() { }
}

/// <summary>返回 StopReason.Error 的结果（模拟模型返回不可重试错误）。</summary>
public sealed class ErrorRunner : IAgentRunner
{
    public IEventBus? Bus { get; set; }
    public string CurrentModel { get; set; } = "deepseek-flash";
    public IReadOnlyList<Skill> ActiveSkills { get; set; } = [];

    public IInterruptSignal? InterruptSignal { get; set; }
    public LlmFailure Failure { get; set; } = new("缺少 API Key", "missing_credential");

    public void ResetHistory() { }

    public async Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
    {
        if (Bus is not null)
            await Bus.PublishAsync(new AgentLoopEvent.TurnCompleted(1, TokenUsage.Zero, Cost: null, new FinishReason.Error(Failure)));
        return new AgentResult
        {
            Answer = "",
            Trajectory = [ChatMessage.User(userMessage)],
            Iterations = 1,
            StopReason = AgentStopReason.Error,
            Failure = Failure,
        };
    }
}
