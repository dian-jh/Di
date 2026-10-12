namespace Di.Cli;

/// <summary>
/// 回合级中断协调器（roadmap §3 缺口 #3 的实现）：
/// 第一次 Ctrl+C 取消<b>当前回合</b>（保留已写入会话），第二次 Ctrl+C 才放行进程退出；
/// 无回合运行（headless / 空闲）时 Ctrl+C 直接退出。
///
/// 与 Console 解耦（不碰 Console 静态），由 Program.cs 把 <see cref="Console.CancelKeyPress"/>
/// 的事件参数映射到 <see cref="RequestInterrupt"/>，因此本类可独立单测。
/// 语义：
/// <list type="bullet">
/// <item>Repl 每回合进入时 <see cref="BeginTurn"/> 注册该回合的取消源，结束时 <see cref="EndTurn"/> 注销。</item>
/// <item><see cref="RequestInterrupt"/> 返回 true = 已处理（应设置 <c>e.Cancel = true</c> 抑制进程终止）；</item>
/// <item>返回 false = 放行默认行为（应设置 <c>e.Cancel = false</c>，让进程退出）。</item>
/// </list>
/// </summary>
public sealed class InterruptCoordinator
{
    private readonly object _gate = new();
    private readonly CancellationTokenSource _lifetime = new();
    private CancellationTokenSource? _turnCts;
    private bool _turnInterrupted;

    /// <summary>进程生命周期取消源：第二次 Ctrl+C 时取消（配合默认退出）；也供宿主做清理。</summary>
    public CancellationToken Lifetime => _lifetime.Token;

    /// <summary>注册当前回合的取消源（回合开始时调用）。同一时刻只跟踪一个回合。</summary>
    public void BeginTurn(CancellationTokenSource turnCts)
    {
        ArgumentNullException.ThrowIfNull(turnCts);
        lock (_gate)
        {
            _turnCts = turnCts;
            _turnInterrupted = false;   // 新回合重新从"第一次"计
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
                _turnInterrupted = false;
            }
        }
    }

    /// <summary>
    /// 处理一次中断（Ctrl+C）。
    /// 第一次且当前有回合：取消该回合、返回 true（抑制进程终止）；
    /// 否则：取消生命周期、返回 false（放行进程默认退出）。
    /// </summary>
    public bool RequestInterrupt()
    {
        CancellationTokenSource? turn;
        lock (_gate)
        {
            if (!_turnInterrupted && _turnCts is { } active)
            {
                _turnInterrupted = true;
                turn = active;
            }
            else
            {
                _lifetime.Cancel();
                return false;
            }
        }
        // 锁外取消：取消回调可能在取消瞬间同步执行，避免持锁。
        // 竞态防护：回合恰好在取消前结束（EndTurn 后 CTS 被 dispose）时忽略，不视为处理失败。
        try { turn.Cancel(); }
        catch (ObjectDisposedException) { }
        return true;
    }
}
