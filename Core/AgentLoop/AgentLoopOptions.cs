namespace Core.AgentLoop;

/// <summary>
/// Agent loop 配置。由组合根从配置段绑定；这些默认值只是兜底，让 loop 可独立使用。
/// 所有限制都来自这里，不在代码中写死。
/// </summary>
public sealed class AgentLoopOptions
{
    /// <summary>稳定前缀（system prompt），每次请求都置于历史最前。</summary>
    public string SystemPrompt { get; set; } = "";

    /// <summary>
    /// 0 表示不限制迭代轮数，正整数表示最大轮数；上下文大小由 HistoryBudgetRatio 预算保护。
    /// 可由配置覆盖：AgentLoop:MaxIterations（~/.di/config.json）。
    /// </summary>
    public int MaxIterations { get; set; } = 0;

    /// <summary>
    /// 跨回合记忆占模型上下文窗口的比例上限（0~1，roadmap §3 缺口 #4）。
    /// 每回合结束按当前模型 <see cref="ModelSpec.ContextWindow"/> × 该比例估算 token 预算，
    /// 超限丢最旧整回合，替代/兜底固定轮数启发式；未知上下文窗口时退回轮数裁剪。
    /// 可由配置覆盖：AgentLoop:HistoryBudgetRatio（~/.di/config.json）。
    /// </summary>
    public double HistoryBudgetRatio { get; set; } = 0.5;

    /// <summary>
    /// 最终输出工具名：模型调用它表示任务完成，其参数作为最终答案返回
    /// （<see cref="AgentStopReason.FinalOutputTool"/>）。null = 不启用该退出条件。
    /// </summary>
    public string? FinalOutputTool { get; set; }

    /// <summary>透传给模型请求。</summary>
    public int? MaxTokens { get; set; }

    /// <summary>透传给模型请求（不透明 ID，值域由适配器声明）。</summary>
    public string? ReasoningEffort { get; set; }
}
