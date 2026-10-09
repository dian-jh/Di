using Core.AgentLoop;
using Core.Skills;

namespace Di.Cli;

/// <summary>
/// 一次聊天回合的驱动者：把用户输入变成一次 <see cref="ReAct"/> 运行。
/// 由 UI 层调用；运行中的循环事件经共享总线发布，UI 再从总线消费渲染。
/// </summary>
public interface IAgentRunner
{
    /// <summary>当前生效的模型名（/model 命令可切换）。</summary>
    string CurrentModel { get; set; }

    /// <summary>当前激活的 skill（/skill 命令设置），其指令随每个回合注入系统上下文。null = 未激活。</summary>
    Skill? ActiveSkill { get; set; }

    /// <summary>运行一个用户回合，返回最终结果。</summary>
    Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default);

    /// <summary>清空跨回合记忆（/clear 命令调用后，模型不再记得之前的对话）。</summary>
    void ResetHistory();
}
