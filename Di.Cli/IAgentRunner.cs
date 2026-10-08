using Core.AgentLoop;

namespace Di.Cli;

/// <summary>
/// 一次聊天回合的驱动者：把用户输入变成一次 <see cref="ReAct"/> 运行。
/// 由 UI 层调用；运行中的循环事件经共享总线发布，UI 再从总线消费渲染。
/// </summary>
public interface IAgentRunner
{
    /// <summary>当前生效的模型名（/model 命令可切换）。</summary>
    string CurrentModel { get; set; }

    /// <summary>运行一个用户回合，返回最终结果。</summary>
    Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default);
}
