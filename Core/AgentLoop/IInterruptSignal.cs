namespace Core.AgentLoop;

/// <summary>
/// 软停止信号（roadmap §3 缺口 #3 的升级）：ReAct 循环只在<b>相位边界</b>轮询它。
/// 请求停止后不再启动<b>新的</b>相位（不发起新的模型调用、不执行新的工具），
/// 但<b>已开始</b>的相位（在途模型调用 / 正在执行的工具）会自然跑完 —— 循环以
/// <see cref="AgentStopReason.Interrupted"/> 正常收敛（保留已发生的 usage/cost 与部分轨迹）。
///
/// 与硬取消（<see cref="System.Threading.CancellationToken"/>）<b>正交</b>，两者不互相替代：
/// <list type="bullet">
/// <item><b>软停止 = 本接口</b>：优雅、可保留状态，用于"用户想停下但不想丢工作"。</item>
/// <item><b>硬取消 = CancellationToken</b>：立即打断在途 I/O（如杀死子进程），
///   用于软停止也救不了的场景（工具卡死）——由前端升级触发（如第二次 Ctrl+C）。</item>
/// </list>
///
/// 实现在前端（CLI/TUI/RPC）侧持有，由宿主注入；循环不认识任何具体前端。
/// </summary>
public interface IInterruptSignal
{
    /// <summary>是否已请求软停止。循环在相位边界读取：true = 应优雅收敛。</summary>
    bool IsStopRequested { get; }
}
