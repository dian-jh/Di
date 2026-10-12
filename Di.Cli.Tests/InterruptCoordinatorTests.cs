using Di.Cli;

namespace Di.Cli.Tests;

/// <summary>
/// 针对 <see cref="InterruptCoordinator"/> 的单元测试：回合级中断协调器。
/// 语义（roadmap §3 缺口 #3）：第一次 Ctrl+C 取消当前回合（保留已写入会话），
/// 第二次才放行进程退出；无回合（headless / 空闲）时 Ctrl+C 直接退出。
/// </summary>
public sealed class InterruptCoordinatorTests
{
    [Fact]
    public void FirstInterrupt_CancelsActiveTurn_AndReturnsTrue()
    {
        var interrupt = new InterruptCoordinator();
        using var turn = new CancellationTokenSource();
        interrupt.BeginTurn(turn);

        var handled = interrupt.RequestInterrupt();

        Assert.True(handled, "第一次 Ctrl+C 应被处理（抑制进程终止）");
        Assert.True(turn.IsCancellationRequested, "第一次 Ctrl+C 应取消当前回合");
        Assert.False(interrupt.Lifetime.IsCancellationRequested, "只取消回合，不应取消生命周期");
    }

    [Fact]
    public void SecondInterrupt_AllowsExit_AndReturnsFalse()
    {
        var interrupt = new InterruptCoordinator();
        using var turn = new CancellationTokenSource();
        interrupt.BeginTurn(turn);

        Assert.True(interrupt.RequestInterrupt());   // 第一次：取消回合
        var handled = interrupt.RequestInterrupt();  // 第二次：放行默认退出

        Assert.False(handled, "第二次 Ctrl+C 应放行进程退出");
        Assert.True(interrupt.Lifetime.IsCancellationRequested);
    }

    [Fact]
    public void InterruptWithoutActiveTurn_AllowsExit()
    {
        var interrupt = new InterruptCoordinator();

        var handled = interrupt.RequestInterrupt();

        Assert.False(handled, "无回合（headless / 空闲）时 Ctrl+C 应直接退出");
        Assert.True(interrupt.Lifetime.IsCancellationRequested);
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
    public void NewTurn_AfterInterrupt_StartsFresh()
    {
        var interrupt = new InterruptCoordinator();
        using var first = new CancellationTokenSource();
        interrupt.BeginTurn(first);
        Assert.True(interrupt.RequestInterrupt());   // 第一次 Ctrl+C 取消回合
        interrupt.EndTurn(first);

        using var second = new CancellationTokenSource();
        interrupt.BeginTurn(second);

        var handled = interrupt.RequestInterrupt();   // 新回合的第一次 Ctrl+C 再次只取消回合

        Assert.True(handled);
        Assert.True(second.IsCancellationRequested);
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
