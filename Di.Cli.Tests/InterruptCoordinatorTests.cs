using Di.Cli;

namespace Di.Cli.Tests;

/// <summary>
/// 针对 <see cref="InterruptCoordinator"/> 的单元测试：回合级中断协调器（递进式强度）。
/// 语义：第一次 Ctrl+C = 软停止（请求回合在相位边界优雅收敛，不打断在途工作），
/// 第二次 Ctrl+C = 硬取消当前回合（打断在途 I/O），无回合（headless / 空闲）时直接退出。
/// 详见 docs/modules/interrupt.md。
/// </summary>
public sealed class InterruptCoordinatorTests
{
    [Fact]
    public void FirstInterrupt_RequestsSoftStop_DoesNotCancelTurn_AndReturnsTrue()
    {
        var interrupt = new InterruptCoordinator();
        using var turn = new CancellationTokenSource();
        interrupt.BeginTurn(turn);

        var handled = interrupt.RequestInterrupt();

        Assert.True(handled, "第一次 Ctrl+C 应被处理（抑制进程终止）");
        Assert.True(interrupt.IsStopRequested, "第一次 Ctrl+C 应请求软停止");
        Assert.False(turn.IsCancellationRequested, "软停止不应取消回合的硬取消源（在途工作照常跑完）");
        Assert.False(interrupt.Lifetime.IsCancellationRequested, "只请求停止，不应取消生命周期");
    }

    [Fact]
    public void SecondInterrupt_HardCancelsTurn_AndReturnsTrue()
    {
        var interrupt = new InterruptCoordinator();
        using var turn = new CancellationTokenSource();
        interrupt.BeginTurn(turn);

        Assert.True(interrupt.RequestInterrupt());   // 第一次：软停止
        var handled = interrupt.RequestInterrupt();  // 第二次：升级为硬取消

        Assert.True(handled, "第二次 Ctrl+C 仍是回合级处理（抑制进程立即终止，让回合干净收尾）");
        Assert.True(turn.IsCancellationRequested, "第二次 Ctrl+C 应硬取消当前回合");
        Assert.False(interrupt.Lifetime.IsCancellationRequested, "硬取消回合不等于退出进程");
    }

    [Fact]
    public void InterruptWithoutActiveTurn_AllowsExit()
    {
        var interrupt = new InterruptCoordinator();

        var handled = interrupt.RequestInterrupt();

        Assert.False(handled, "无回合（headless / 空闲）时 Ctrl+C 应直接退出");
        Assert.True(interrupt.Lifetime.IsCancellationRequested);
        Assert.False(interrupt.IsStopRequested);
    }

    [Fact]
    public void InterruptAfterTurnEnded_AllowsExit()
    {
        var interrupt = new InterruptCoordinator();
        using var turn = new CancellationTokenSource();
        interrupt.BeginTurn(turn);
        interrupt.EndTurn(turn);   // 回合正常结束，注销

        var handled = interrupt.RequestInterrupt();

        Assert.False(handled);
    }

    [Fact]
    public void EndTurn_ClearsSoftStopRequest()
    {
        var interrupt = new InterruptCoordinator();
        using var turn = new CancellationTokenSource();
        interrupt.BeginTurn(turn);
        interrupt.RequestInterrupt();   // 软停止
        Assert.True(interrupt.IsStopRequested);

        interrupt.EndTurn(turn);

        Assert.False(interrupt.IsStopRequested, "回合结束后软停止标志应清除，避免影响下一次轮询");
    }

    [Fact]
    public void NewTurn_AfterInterrupt_StartsFresh()
    {
        var interrupt = new InterruptCoordinator();
        using var first = new CancellationTokenSource();
        interrupt.BeginTurn(first);
        Assert.True(interrupt.RequestInterrupt());   // 第一次 Ctrl+C 软停止
        interrupt.EndTurn(first);

        using var second = new CancellationTokenSource();
        interrupt.BeginTurn(second);

        var handled = interrupt.RequestInterrupt();   // 新回合的第一次 Ctrl+C 再次只是软停止

        Assert.True(handled);
        Assert.True(interrupt.IsStopRequested);
        Assert.False(second.IsCancellationRequested, "新回合的第一次 Ctrl+C 不应硬取消");
        Assert.False(interrupt.Lifetime.IsCancellationRequested, "新回合的第一次 Ctrl+C 不应直接退出进程");
    }

    [Fact]
    public void Interrupt_DoesNotCancelStaleTurn_AfterEndTurn()
    {
        var interrupt = new InterruptCoordinator();
        using var turn = new CancellationTokenSource();
        interrupt.BeginTurn(turn);
        interrupt.EndTurn(turn);   // 回合结束

        interrupt.RequestInterrupt();   // 此刻 Ctrl+C 直接退出（不会去取消已结束的回合）

        Assert.False(turn.IsCancellationRequested);
    }
}
