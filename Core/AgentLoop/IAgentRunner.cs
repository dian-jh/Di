using Core.Skills;

namespace Core.AgentLoop;

/// <summary>
/// 一次聊天回合的驱动者（harness 层会话 API）：把用户输入变成一次 <see cref="ReAct"/> 运行。
/// 由 CLI 层调用；运行中的循环事件经共享总线发布，UI 再从总线消费渲染。
///
/// 这是 harness 与 CLI 之间的<b>稳定契约</b>：任何语言重写 CLI 层时，都通过这个接口
/// 驱动同一个会话（配合 <see cref="AgentLoopEvent"/> 事件流与 <see cref="AgentResult"/> 结果）。
/// </summary>
public interface IAgentRunner
{
    /// <summary>当前生效的模型名（/model 命令可切换）。</summary>
    string CurrentModel { get; set; }

    /// <summary>当前注入的 skills（固定激活 + 每回合自动匹配，可叠加），指令随每个回合注入系统上下文。</summary>
    IReadOnlyList<Skill> ActiveSkills { get; set; }

    /// <summary>
    /// 软停止信号（由前端注入，可空）：设置后，正在运行的回合会在下一个相位边界优雅停下
    /// （<see cref="AgentStopReason.Interrupted"/>），不打断已开始的工作。会话级属性，与
    /// <see cref="CurrentModel"/> / <see cref="ActiveSkills"/> 同款：前端持有并设置，harness 只读。
    /// </summary>
    IInterruptSignal? InterruptSignal { get; set; }

    /// <summary>运行一个用户回合，返回最终结果。</summary>
    Task<AgentResult> RunAsync(string userMessage, CancellationToken cancellationToken = default);

    /// <summary>清空跨回合记忆（/clear 命令调用后，模型不再记得之前的对话）。</summary>
    void ResetHistory();
}
