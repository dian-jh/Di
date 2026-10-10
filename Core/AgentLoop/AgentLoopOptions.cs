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
    /// 循环上限，防止模型无限循环。到达后以 <see cref="AgentStopReason.MaxIterations"/> 结束。
    /// 默认 24：一次迭代 = 一次模型往返（通常含一次工具调用）；复杂分析/测试-修复循环动辄
    /// 10-20 轮，8 轮会截断信息收集。DeepSeek 上下文 1M token + 前缀缓存命中率 ~75%，
    /// 每轮边际成本极低，放宽上限几乎无代价；真正防失控的是成本/上下文预算（见 docs/harness.md 缺口 #4）。
    /// 可由配置覆盖：AgentLoop:MaxIterations（~/.di/config.json）。
    /// </summary>
    public int MaxIterations { get; set; } = 24;

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
