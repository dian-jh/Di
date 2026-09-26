namespace Core.AgentLoop;

/// <summary>
/// Agent loop 配置。由组合根从配置段绑定；这些默认值只是兜底，让 loop 可独立使用。
/// 所有限制都来自这里，不在代码中写死。
/// </summary>
public sealed class AgentLoopOptions
{
    /// <summary>稳定前缀（system prompt），每次请求都置于历史最前。</summary>
    public string SystemPrompt { get; set; } = "";

    /// <summary>循环上限，防止模型无限循环。到达后以 <see cref="AgentStopReason.MaxIterations"/> 结束。</summary>
    public int MaxIterations { get; set; } = 8;

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
