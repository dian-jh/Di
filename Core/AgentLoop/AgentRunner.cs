using Common.Events;
using Core.Llm;
using Core.Skills;

namespace Core.AgentLoop;

/// <summary>
/// <see cref="IAgentRunner"/> 的标准实现：按当前模型名经工厂解析 <see cref="IChatModel"/>，
/// 把用户输入组装成 <see cref="AgentRequest"/> 交给 <see cref="ReAct"/> 执行。
/// 走流式路径：模型文本增量以 <see cref="AgentLoopEvent.TextDelta"/> 事件实时发布到
/// 共享 <see cref="IEventBus"/>，UI 从同一总线消费渲染。
///
/// 属于 harness 层（Core），不依赖任何 CLI 具体实现 —— 交互 REPL 与 headless 单发模式共用。
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
    private readonly IReadOnlyList<Skill> _skills;
    private readonly string? _workingDirectory;
    private readonly int _maxHistoryTurns;
    private readonly Func<string, int?>? _contextWindowProvider;
    private IReadOnlyList<ChatMessage> _history = [];

    /// <summary>最近一次追加进历史的快照文本。快照只在内容变化时追加（见 <see cref="RunAsync"/>），
    /// 未变时不重复注入 → 已进入历史的快照留在字节稳定前缀里，跨回合持续命中缓存。</summary>
    private string? _lastSnapshotText;

    public AgentRunner(
        Func<string, IChatModel> modelFactory,
        IToolExecutor toolExecutor,
        AgentLoopOptions options,
        IEventBus eventBus,
        IReadOnlyList<ChatTool>? tools = null,
        string? workingDirectory = null,
        int maxHistoryTurns = DefaultMaxHistoryTurns,
        Func<string, int?>? contextWindowProvider = null,
        IReadOnlyList<Skill>? skills = null)
    {
        _modelFactory = modelFactory ?? throw new ArgumentNullException(nameof(modelFactory));
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _eventBus = eventBus ?? throw new ArgumentNullException(nameof(eventBus));
        _skills = skills ?? [];
        // 有 skill 时：给模型提供 load_skill 工具，并把执行器包一层拦截该调用；其余委托原执行器。
        var toolList = tools is null ? new List<ChatTool>() : [.. tools];
        if (_skills.Count > 0)
            toolList.Add(SkillTools.LoadSkillTool);
        _tools = toolList;
        _toolExecutor = _skills.Count > 0
            ? new SkillAwareExecutor(toolExecutor, _skills)
            : toolExecutor ?? throw new ArgumentNullException(nameof(toolExecutor));
        _workingDirectory = workingDirectory;
        _maxHistoryTurns = Math.Max(0, maxHistoryTurns);
        _contextWindowProvider = contextWindowProvider;
    }

    public string CurrentModel { get; set; } = "deepseek-flash";

    /// <summary>
    /// 当前注入的 skills（可叠加）：固定激活（/skill 设置，跨回合保持）+ 每回合自动匹配（host 临时算）。
    /// 指令按顺序拼进系统上下文。
    /// </summary>
    public IReadOnlyList<Skill> ActiveSkills { get; set; } = [];

    /// <summary>软停止信号（前端注入）：每回合转发给 <see cref="ReAct"/>，在相位边界轮询。</summary>
    public IInterruptSignal? InterruptSignal { get; set; }

    public void ResetHistory()
    {
        _history = [];
        _lastSnapshotText = null;   // 重置后快照应重新注入
    }

    public async Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
    {
        var model = _modelFactory(CurrentModel);
        var react = new ReAct(model, _options, _eventBus, InterruptSignal);

        // 环境快照进持久历史，且只在内容变化时追加：稳定时它留在字节稳定前缀里，跨回合/迭代
        // 持续命中缓存，零重复支付；变化时（git 状态改变等）作为新 system 消息追加到历史末尾，
        // 付一次成本后也进入缓存前缀。相比"每回合重发到请求末尾"，不再为未变化的环境反复花钱。
        if (!string.IsNullOrWhiteSpace(_workingDirectory))
        {
            var snapshot = await EnvironmentSnapshot.CaptureAsync(_workingDirectory, cancellationToken: cancellationToken)
                .ConfigureAwait(false);
            if (snapshot != _lastSnapshotText)
            {
                _lastSnapshotText = snapshot;
                _history = [.. _history, ChatMessage.System(snapshot)];
            }
        }

        // 系统上下文 = 已激活 skill 的指令 + 未激活 skill 的广告块（渐进式披露的 Advertise 阶段）。
        // skill 是用户/匹配器按本轮任务选定的，语义上属于本轮，仍放请求末尾（易变但体量小、有界）。
        // 广告块：未激活的 skill 只注入 name+description，完整指令由模型按需 load_skill 加载。
        string? systemContext = null;
        var advertised = _skills.Where(s => !ActiveSkills.Contains(s)).ToList();
        if (advertised.Count > 0)
        {
            var advertise = "可用 skills（需要时用 load_skill 加载完整指令）：\n" + SkillContext.BuildAdvertisement(advertised);
            systemContext = advertise;
        }
        // 固定激活（/skill）与自动匹配的 skill：完整指令注入——这是用户/匹配器显式选定的工作流。
        if (ActiveSkills is { Count: > 0 })
        {
            var skillContext = string.Join("\n\n", ActiveSkills
                .Select(s => $"【已激活 Skill：{s.Name}】\n{s.Instructions}"));
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

        // 累加本回合轨迹作为下一回合的记忆，按整回合（user 消息为界）裁剪：
        // 先按当前模型的上下文 token 预算丢最旧（roadmap §3 缺口 #4），再按最大轮数兜底。
        // 未知上下文窗口（provider 返回 null）时 token 预算裁剪自动退化为纯轮数启发式。
        // 最后对尾部做工具良构化：封顶/最终输出工具回合会留下"未执行的 tool_calls"，必须剔除。
        int? tokenBudget = null;
        try
        {
            tokenBudget = _contextWindowProvider?.Invoke(CurrentModel) is { } window
                ? (int?)Math.Max(1, window * _options.HistoryBudgetRatio)
                : null;
        }
        catch
        {
            // 目录/窗口解析失败（第三方 provider 异常等）：退回轮数启发式，绝不让预算查询拖垮回合。
        }
        _history = SanitizeHistory(TrimHistoryByTokens(TrimHistory(result.Trajectory, _maxHistoryTurns), tokenBudget));
        // 裁剪可能把最早注入的快照裁出历史：重置标记，让下一回合重新注入（否则长期会话会失去环境上下文）。
        if (_lastSnapshotText is not null && !_history.OfType<SystemMessage>().Any(m => m.Text == _lastSnapshotText))
            _lastSnapshotText = null;
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

    /// <summary>
    /// 按 token 预算丢弃最旧整回合，直到估算量回到预算内；至少保留最近 1 轮（当前回合不能被全丢，
    /// 否则下一回合连上下文都没有）。预算 null / 非正数时原样返回（由调用方退回轮数启发式）。
    /// </summary>
    private static IReadOnlyList<ChatMessage> TrimHistoryByTokens(
        IReadOnlyList<ChatMessage> trajectory, int? tokenBudget)
    {
        if (tokenBudget is null or <= 0)
            return trajectory;
        var userCount = trajectory.Count(m => m is UserMessage);
        if (userCount <= 1 || EstimateTokens(trajectory) <= tokenBudget)
            return trajectory;

        // 从最旧开始逐轮丢弃，直到估算回到预算内或只剩最近 1 轮。
        for (var toDrop = 1; toDrop < userCount; toDrop++)
        {
            var remaining = DropOldestTurns(trajectory, toDrop);
            if (EstimateTokens(remaining) <= tokenBudget)
                return remaining;
        }
        return DropOldestTurns(trajectory, userCount - 1);
    }

    /// <summary>丢弃最旧的 <paramref name="toDrop"/> 个整回合，返回剩余（含剩余 user 消息及其后全部）。</summary>
    private static IReadOnlyList<ChatMessage> DropOldestTurns(IReadOnlyList<ChatMessage> trajectory, int toDrop)
    {
        var seen = 0;
        for (var i = 0; i < trajectory.Count; i++)
        {
            if (trajectory[i] is UserMessage && seen++ == toDrop)
                return trajectory.Skip(i).ToArray();
        }
        return trajectory;
    }

    /// <summary>估算历史 token 数：每条消息可见文本（+ assistant 推理链）按 ~4 字符/token。</summary>
    private static int EstimateTokens(IReadOnlyList<ChatMessage> messages)
    {
        var total = 0;
        foreach (var message in messages)
        {
            total += TokenEstimator.Estimate(ChatMessageExtensions.GetText(message));
            if (message is AssistantMessage { Reasoning: { } reasoning })
                total += TokenEstimator.Estimate(reasoning);
        }
        return total;
    }

    /// <summary>
    /// 跨回合记忆必须"工具良构"：assistant 的 tool_calls 必须紧跟对应的 tool 结果。
    /// 封顶（<see cref="AgentStopReason.MaxIterations"/>）或最终输出工具
    /// （<see cref="AgentStopReason.FinalOutputTool"/>）回合会以"未执行的 tool_calls"结尾——
    /// 该悬空 assistant 消息若带进下一轮请求，provider（如 DeepSeek）会以 invalid_request_error
    /// 拒绝整个请求。从尾部丢弃未获响应的 tool_calls，直到历史良构。
    /// 只修剪<b>持久化记忆</b>，不动回合结果：轨迹仍是可重放的完整状态。
    /// </summary>
    private static IReadOnlyList<ChatMessage> SanitizeHistory(IReadOnlyList<ChatMessage> history)
    {
        var end = history.Count;
        while (end > 0 && history[end - 1] is AssistantMessage { ToolCalls.Count: > 0 })
            end--;
        return end == history.Count ? history : history.Take(end).ToArray();
    }
}
