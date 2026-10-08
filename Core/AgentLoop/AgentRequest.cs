using Core.Llm;

namespace Core.AgentLoop;

/// <summary>一次 loop 运行的全部输入（模型与配置在构造时注入，不随请求走）。</summary>
public sealed class AgentRequest
{
    /// <summary>用户的请求消息，作为 trajectory 的起点。</summary>
    public required string UserMessage { get; init; }

    /// <summary>
    /// 可选的追加系统上下文（如环境快照），置于 stable_prefix 之后、历史之前，随每次请求刷新。
    /// null = 无。
    /// </summary>
    public string? SystemContext { get; init; }

    /// <summary>本次运行中模型可以调用的工具。</summary>
    public IReadOnlyList<ChatTool>? Tools { get; init; }

    /// <summary>工具如何执行（环境）。</summary>
    public required IToolExecutor ToolExecutor { get; init; }

    /// <summary>可选的执行前校验步骤（安全/权限挂点）。null = 跳过校验。</summary>
    public IToolValidator? Validator { get; init; }
}
