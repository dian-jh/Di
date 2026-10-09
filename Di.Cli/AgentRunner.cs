using Common.Events;
using Core.AgentLoop;
using Core.Llm;
using Core.Skills;

namespace Di.Cli;

/// <summary>
/// <see cref="IAgentRunner"/> 的标准实现：按当前模型名经工厂解析 <see cref="IChatModel"/>，
/// 把用户输入组装成 <see cref="AgentRequest"/> 交给 <see cref="ReAct"/> 执行。
/// 走流式路径：模型文本增量以 <see cref="AgentLoopEvent.TextDelta"/> 事件实时发布到
/// 共享 <see cref="IEventBus"/>，UI 从同一总线消费渲染。
/// </summary>
public sealed class AgentRunner : IAgentRunner
{
    /// <summary>跨回合记忆默认保留的最近回合数（超出丢最旧整回合，控制上下文膨胀）。</summary>
    public const int DefaultMaxHistoryTurns = 10;

    private readonly Func<string, IChatModel> _modelFactory;
    private readonly AgentLoopOptions _options;
    private readonly IEventBus _eventBus;
    private readonly IReadOnlyList<ChatTool> _tools;
    private readonly IToolExecutor _toolExecutor;
    private readonly string? _workingDirectory;
    private readonly int _maxHistoryTurns;
    private IReadOnlyList<ChatMessage> _history = [];

    public AgentRunner(
        Func<string, IChatModel> modelFactory,
        IToolExecutor toolExecutor,
        AgentLoopOptions options,
        IEventBus eventBus,
        IReadOnlyList<ChatTool>? tools = null,
        string? workingDirectory = null,
        int maxHistoryTurns = DefaultMaxHistoryTurns)
    {
        _modelFactory = modelFactory ?? throw new ArgumentNullException(nameof(modelFactory));
        _toolExecutor = toolExecutor ?? throw new ArgumentNullException(nameof(toolExecutor));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _eventBus = eventBus ?? throw new ArgumentNullException(nameof(eventBus));
        _tools = tools ?? [];
        _workingDirectory = workingDirectory;
        _maxHistoryTurns = Math.Max(0, maxHistoryTurns);
    }

    public string CurrentModel { get; set; } = "deepseek-flash";

    /// <summary>当前激活的 skill（/skill 命令设置）：指令随每个回合注入系统上下文。null = 未激活。</summary>
    public Skill? ActiveSkill { get; set; }

    public void ResetHistory() => _history = [];

    public async Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
    {
        var model = _modelFactory(CurrentModel);
        var react = new ReAct(model, _options, _eventBus);

        // 系统上下文 = 环境快照 + 已激活 skill 的指令。skill 是用户显式挂上的工作流，
        // 放在快照之后更贴近本轮任务；两者都尽力而为，绝不阻塞回合。
        string? systemContext = null;
        if (!string.IsNullOrWhiteSpace(_workingDirectory))
        {
            systemContext = await EnvironmentSnapshot.CaptureAsync(_workingDirectory, cancellationToken: cancellationToken)
                .ConfigureAwait(false);
        }
        if (ActiveSkill is not null)
        {
            var skillContext = $"【已激活 Skill：{ActiveSkill.Name}】\n{ActiveSkill.Instructions}";
            systemContext = systemContext is null
                ? skillContext
                : systemContext + "\n\n" + skillContext;
        }

        var result = await react.RunStreamingAsync(new AgentRequest
        {
            UserMessage = userMessage,
            History = _history,   // 上一回合的完整轨迹 → 模型"记得"之前的对话
            Tools = _tools,
            ToolExecutor = _toolExecutor,
            SystemContext = systemContext,
        }, cancellationToken).ConfigureAwait(false);

        // 累加本回合轨迹作为下一回合的记忆，并裁剪到最近 N 轮（按整回合在 user 消息处切）。
        _history = TrimHistory(result.Trajectory, _maxHistoryTurns);
        return result;
    }

    /// <summary>保留最近 <paramref name="maxTurns"/> 轮整回合（每个回合以 user 消息为起点）。</summary>
    private static IReadOnlyList<ChatMessage> TrimHistory(IReadOnlyList<ChatMessage> trajectory, int maxTurns)
    {
        if (maxTurns <= 0)
            return [];
        var userCount = trajectory.Count(m => m is UserMessage);
        if (userCount <= maxTurns)
            return trajectory;

        // 裁掉最旧的 (userCount - maxTurns) 个整回合，起点是第 (toDrop+1) 个 user 消息。
        var toDrop = userCount - maxTurns;
        var seen = 0;
        for (var i = 0; i < trajectory.Count; i++)
        {
            if (trajectory[i] is UserMessage && seen++ == toDrop)
                return trajectory.Skip(i).ToArray();
        }
        return trajectory;
    }
}
