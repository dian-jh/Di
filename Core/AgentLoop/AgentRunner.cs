using Common.Events;
using Core.ContextManagement;
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
    private readonly Func<string, IChatModel> _modelFactory;
    private readonly AgentLoopOptions _options;
    private readonly IEventBus _eventBus;
    private readonly IReadOnlyList<ChatTool> _tools;
    private readonly IToolExecutor _toolExecutor;
    private readonly IReadOnlyList<Skill> _skills;
    private readonly string? _workingDirectory;
    private readonly int _maxHistoryTurns;
    private readonly Func<string, int?>? _contextWindowProvider;
    private readonly BudgetPolicy? _budgetPolicy;
    private readonly Func<BudgetPolicy?>? _budgetPolicyProvider;
    private readonly InputBudgetTracker? _budgetTracker;
    private IReadOnlyList<ChatMessage> _history = [];
    private int? _lastHistoryBudget;

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
        int maxHistoryTurns = 0,
        Func<string, int?>? contextWindowProvider = null,
        IReadOnlyList<Skill>? skills = null,
        BudgetPolicy? budgetPolicy = null,
        InputBudgetTracker? budgetTracker = null, Func<BudgetPolicy?>? budgetPolicyProvider = null)
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
        _budgetPolicy = budgetPolicy;
        _budgetTracker = budgetTracker;
        _budgetPolicyProvider = budgetPolicyProvider;
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
        _lastHistoryBudget = null;
        _lastSnapshotText = null;   // 重置后快照应重新注入
        _budgetTracker?.Update(0);  // B_current holder 同步归零（见 RunAsync 末尾的写入点）
    }

    public async Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default)
    {
        // 用户输入的日志记录点（与 ReAct.Emit 同款旁路、fire-and-forget）：REPL / headless / RPC
        // 所有前端都经本方法进入，在此一处发布 RunStarted 即全覆盖。事件不属于 AgentLoopEvent
        // 家族（避免扩进 RPC 线协议，见 RunEvents.cs），日志订阅者据此记 run: started。
        _ = _eventBus.PublishAsync(new RunStarted(userMessage));

        var model = _modelFactory(CurrentModel);
        var budgetPolicy = _budgetPolicyProvider is null ? _budgetPolicy : _budgetPolicyProvider();
        if (budgetPolicy is not null && (_lastHistoryBudget is null || budgetPolicy.SoftThreshold < _lastHistoryBudget))
        {
            _history = SanitizeHistory(TrimHistoryByTokens(_history, budgetPolicy.SoftThreshold));
            // These are previous turns only; the new user message is added below.
            if (EstimateTokens(_history) > budgetPolicy.SoftThreshold) _history = [];
            if (_lastSnapshotText is not null && !_history.OfType<SystemMessage>().Any(m => m.Text == _lastSnapshotText))
                _lastSnapshotText = null;
            _budgetTracker?.Update(EstimateTokens(_history));
        }
        var react = new ReAct(model, _options, _eventBus, InterruptSignal);

        // 环境快照进持久历史，且只在内容变化时追加：快照已最小化（仅"工作目录 + 自取提示"，见
        // EnvironmentSnapshot，参考 pi 的"最小化注入 + 工具自取"）→ 内容恒定，首次注入后即留在
        // 字节稳定前缀里，跨回合/迭代持续命中缓存，零重复支付。相比"每回合重发到请求末尾"，不再为环境反复花钱。
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
            BeforeToolExecution = _budgetTracker is null ? null : trajectory =>
                _budgetTracker.Update(EstimateTokens(trajectory)),
        }, cancellationToken).ConfigureAwait(false);

        // 累加本回合轨迹作为下一回合的记忆，按整回合（user 消息为界）裁剪（预算独占）：
        // - token 预算非 null（注入 BudgetPolicy 或窗口 × ratio）→ 预算裁剪独占，轮数裁剪完全不参与
        //   （阶段一预算制，docs/context-compression.md §9：注入 BudgetPolicy 时以 soft 水位线
        //   B_input × SoftRatio 为预算——B_input 已扣输出/安全预留；未注入时退回窗口 × HistoryBudgetRatio）。
        // - token 预算 null（窗口解析失败，唯一可能无界的降级路径）→ 仅当调用方显式传
        //   maxHistoryTurns &gt; 0 时按轮数裁剪兜底；0 / 不传 = 无轮数上限（历史原样保留）。
        // 最后对尾部做工具良构化：封顶/最终输出工具回合会留下"未执行的 tool_calls"，必须剔除。
        int? tokenBudget = null;
        if (budgetPolicy is not null)
        {
            tokenBudget = budgetPolicy.SoftThreshold;
        }
        else
        {
            try
            {
                tokenBudget = _contextWindowProvider?.Invoke(CurrentModel) is { } window
                    ? (int?)Math.Max(1, window * _options.HistoryBudgetRatio)
                    : null;
            }
            catch
            {
                // 目录/窗口解析失败（第三方 provider 异常等）：tokenBudget 保持 null → 走显式轮数兜底。
            }
        }
        var trimmed = tokenBudget is not null
            ? TrimHistoryByTokens(result.Trajectory, tokenBudget)   // 预算独占
            : TrimHistory(result.Trajectory, _maxHistoryTurns);     // 显式 maxHistoryTurns 兜底（0 = 无上限）
        _history = SanitizeHistory(trimmed);
        _lastHistoryBudget = tokenBudget;
        // 裁剪可能把最早注入的快照裁出历史：重置标记，让下一回合重新注入（否则长期会话会失去环境上下文）。
        if (_lastSnapshotText is not null && !_history.OfType<SystemMessage>().Any(m => m.Text == _lastSnapshotText))
            _lastSnapshotText = null;
        // 回合末同步裁剪后的记忆；工具执行前另按实时轨迹更新。稳定前缀由 B_margin 覆盖。
        _budgetTracker?.Update(EstimateTokens(_history));
        return result;
    }

    /// <summary>
    /// 按显式 <paramref name="maxTurns"/> 保留最近 N 轮整回合（每个回合以 user 消息为起点）。
    /// 仅作为"无预算降级路径"的显式兜底（<see cref="RunAsync"/> 里 tokenBudget 为 null 时才调用，
    /// 调用方显式传 &gt; 0 才启用）；&le; 0 / 不传 = 不启用轮数上限，原样返回轨迹（不裁剪、绝不清空历史）。
    /// </summary>
    private static IReadOnlyList<ChatMessage> TrimHistory(IReadOnlyList<ChatMessage> trajectory, int maxTurns)
    {
        if (maxTurns <= 0)
            return trajectory;
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
    /// 未配齐结果的调用组会导致 provider 拒绝下一轮请求；从尾部整组移除 assistant 和部分结果。
    /// 只修剪<b>持久化记忆</b>，不动回合结果：轨迹仍是可重放的完整状态。
    /// </summary>
    private static IReadOnlyList<ChatMessage> SanitizeHistory(IReadOnlyList<ChatMessage> history)
    {
        var end = history.Count;
        while (end > 0)
        {
            var assistantIndex = end - 1;
            while (assistantIndex >= 0 && history[assistantIndex] is ToolResultMessage)
                assistantIndex--;
            if (assistantIndex < 0 || history[assistantIndex] is not AssistantMessage { ToolCalls.Count: > 0 } assistant)
                break;

            var resultIds = history.Skip(assistantIndex + 1).Take(end - assistantIndex - 1)
                .OfType<ToolResultMessage>().Select(m => m.ToolCallId).ToHashSet(StringComparer.Ordinal);
            if (assistant.ToolCalls.All(call => resultIds.Contains(call.Id)))
                break;
            end = assistantIndex;
        }
        return end == history.Count ? history : history.Take(end).ToArray();
    }
}
