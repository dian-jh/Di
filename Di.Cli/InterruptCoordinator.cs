using Core.AgentLoop;

namespace Di.Cli;

/// <summary>
/// 回合级中断协调器（roadmap §3 缺口 #3）。把 Ctrl+C 的"重复按下"映射成<b>递进的</b>中断强度，
/// 并作为 <see cref="IInterruptSignal"/> 供 ReAct 在相位边界轮询。与 Console 解耦
/// （不碰 Console 静态），由 Program.cs 把 <see cref="Console.CancelKeyPress"/> 映射到
/// <see cref="RequestInterrupt"/>，因此可独立单测。
///
/// 语义（按下次数递增）：
/// <list type="number">
/// <item><b>第一次 · 软停止</b>：请求当前回合在下一个相位边界优雅收敛
///   （<see cref="AgentStopReason.Interrupted"/>）—— 已开始的模型调用 / 工具跑完，未开始的不启动。
///   回合于是正常返回，已写入会话得以保留。</item>
/// <item><b>第二次 · 硬取消</b>：立即取消当前回合的取消源，打断在途 I/O（如杀死子进程）——
///   用于软停止也救不了的场景（工具卡死）。回合以异常路径快速收尾。</item>
/// <item><b>无回合（headless / 空闲）</b>：取消生命周期、放行进程默认退出。</item>
/// </list>
/// 常见使用下可观测到的行为与旧版一致：第一次 Ctrl+C 结束当前回合，第二次（此时回合已结束）退出进程。
///
/// <see cref="RequestInterrupt"/> 返回 true = 已处理（应设置 <c>e.Cancel = true</c> 抑制进程终止）；
/// 返回 false = 放行默认行为（应设置 <c>e.Cancel = false</c>）。
/// </summary>
public sealed class InterruptCoordinator : IInterruptSignal
{
    private readonly object _gate = new();
    private readonly CancellationTokenSource _lifetime = new();
    private CancellationTokenSource? _turnCts;
    private bool _softRequested;

    /// <summary>进程生命周期取消源：无回合时按下取消它（配合默认退出）；也供宿主做清理。</summary>
    public CancellationToken Lifetime => _lifetime.Token;

    /// <summary>
    /// ReAct 在相位边界轮询的软停止标志。仅在回合并行期间可能为 true；
    /// 回合开始（<see cref="BeginTurn"/>）/ 结束（<see cref="EndTurn"/>）都会重置。
    /// </summary>
    public bool IsStopRequested
    {
        get { lock (_gate) return _softRequested; }
    }

    /// <summary>注册当前回合的取消源（回合开始时调用）。同一时刻只跟踪一个回合。</summary>
    public void BeginTurn(CancellationTokenSource turnCts)
    {
        ArgumentNullException.ThrowIfNull(turnCts);
        lock (_gate)
        {
            _turnCts = turnCts;
            _softRequested = false;   // 新回合重新从"第一次"计
        }
    }

    /// <summary>注销已结束的回合（回合结束时调用）。幂等：只注销自己注册的那个。</summary>
    public void EndTurn(CancellationTokenSource turnCts)
    {
        lock (_gate)
        {
            if (ReferenceEquals(_turnCts, turnCts))
            {
                _turnCts = null;
                _softRequested = false;
            }
        }
    }

    /// <summary>
    /// 处理一次中断（Ctrl+C）。第一次（有回合）→ 软停止请求；第二次 → 硬取消该回合；
    /// 无回合 → 取消生命周期并放行进程退出。返回值见类文档。
    /// </summary>
    public bool RequestInterrupt()
    {
        CancellationTokenSource? toHardCancel;
        lock (_gate)
        {
            if (_turnCts is not { } active)
            {
                // 无回合（headless / 空闲）：放行默认退出。
                _lifetime.Cancel();
                return false;
            }

            if (!_softRequested)
            {
                _softRequested = true;   // 第一次：软停止，抑制进程终止
                return true;
            }

            toHardCancel = active;       // 第二次：升级为硬取消
        }

        // 锁外取消：取消回调可能在取消瞬间同步执行，避免持锁。
        // 竞态防护：回合恰好在取消前结束（CTS 被 dispose）时忽略。
        try { toHardCancel.Cancel(); }
        catch (ObjectDisposedException) { }
        return true;   // 抑制进程终止：让回合走异常路径干净收尾（会话不丢），随后空闲再按下才退出
    }
}
