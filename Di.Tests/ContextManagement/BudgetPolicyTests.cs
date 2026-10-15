using Core.ContextManagement;

namespace Di.Tests.ContextManagement;

/// <summary>
/// <see cref="BudgetPolicy"/> 单测：B_input 公式、三级水位线数学、B_predicted 预测判定、
/// 窗口小于预留的边界、margin 归零边界。设计契约见 docs/context-compression.md §6。
/// </summary>
public sealed class BudgetPolicyTests
{
    // ---- B_input 公式（§6.1）：B_input = B_window - B_output - B_margin ----

    [Fact]
    public void InputBudget_Defaults_WindowMinusOutputReserveMinusTenPercentMargin()
    {
        // 1M 窗口：margin = 10% × 1M = 100k；output reserve = 默认 20k → B_input = 880k。
        var policy = new BudgetPolicy(1_000_000);

        Assert.Equal(1_000_000, policy.Window);
        Assert.Equal(20_000, policy.OutputReserveTokens);
        Assert.Equal(100_000, policy.MarginTokens);
        Assert.Equal(880_000, policy.InputBudget);
    }

    [Fact]
    public void InputBudget_Scale_WithWindow()
    {
        // margin 是窗口的 10%，随窗口缩放：200k 窗口 → margin 20k。
        var policy = new BudgetPolicy(200_000);

        Assert.Equal(20_000, policy.MarginTokens);
        Assert.Equal(160_000, policy.InputBudget);
    }

    [Fact]
    public void InputBudget_MarginRatioZero_ExcludesMargin()
    {
        // margin 归零边界：marginRatio = 0 → margin 不占预算，B_input = window - output。
        var policy = new BudgetPolicy(10_000, marginRatio: 0, outputReserveTokens: 1_000);

        Assert.Equal(0, policy.MarginTokens);
        Assert.Equal(9_000, policy.InputBudget);
    }

    [Fact]
    public void InputBudget_ClampsToZero_WhenWindowBelowReserves()
    {
        // 窗口小于预留（margin 1k + output 20k = 21k > 窗口 10k）：B_input 归零，不得为负。
        var policy = new BudgetPolicy(10_000, outputReserveTokens: 20_000);

        Assert.Equal(1_000, policy.MarginTokens);
        Assert.Equal(0, policy.InputBudget);
        Assert.Equal(0, policy.SoftThreshold);
        Assert.Equal(0, policy.HardThreshold);
        Assert.Equal(0, policy.BlockingThreshold);
    }

    [Fact]
    public void InputBudget_NonPositiveWindow_ClampsToZero()
    {
        var policy = new BudgetPolicy(-5_000);

        Assert.Equal(0, policy.Window);
        Assert.Equal(0, policy.InputBudget);
    }

    // ---- 三级水位线（§6.2）：相对 B_input 的比例，随窗口缩放 ----

    [Fact]
    public void Thresholds_DefaultRatios_ScaleWithInputBudget()
    {
        // 默认 0.7 / 0.8 / 0.9 × B_input = 880k → 616k / 704k / 792k。
        var policy = new BudgetPolicy(1_000_000);

        Assert.Equal(616_000, policy.SoftThreshold);
        Assert.Equal(704_000, policy.HardThreshold);
        Assert.Equal(792_000, policy.BlockingThreshold);
    }

    [Fact]
    public void WaterlineFor_ClassifiesBoundaries_Inclusively()
    {
        var policy = new BudgetPolicy(1_000_000);

        Assert.Equal(Waterline.Under, policy.WaterlineFor(615_999));
        Assert.Equal(Waterline.Soft, policy.WaterlineFor(616_000));   // ≥ soft，但 < hard
        Assert.Equal(Waterline.Soft, policy.WaterlineFor(703_999));
        Assert.Equal(Waterline.Hard, policy.WaterlineFor(704_000));   // ≥ hard，但 < blocking
        Assert.Equal(Waterline.Hard, policy.WaterlineFor(791_999));
        Assert.Equal(Waterline.Blocking, policy.WaterlineFor(792_000));
        Assert.Equal(Waterline.Blocking, policy.WaterlineFor(1_000_000));
    }

    [Fact]
    public void WaterlineFor_ZeroBudget_AnyInputIsBlocking()
    {
        var policy = new BudgetPolicy(10_000, outputReserveTokens: 20_000);

        Assert.Equal(Waterline.Blocking, policy.WaterlineFor(0));
        Assert.Equal(Waterline.Blocking, policy.WaterlineFor(1));
    }

    [Fact]
    public void CustomRatios_AreRespected()
    {
        var policy = new BudgetPolicy(100_000, marginRatio: 0, outputReserveTokens: 0,
            softRatio: 0.5, hardRatio: 0.6, blockingRatio: 0.7);

        Assert.Equal(100_000, policy.InputBudget);
        Assert.Equal(50_000, policy.SoftThreshold);
        Assert.Equal(60_000, policy.HardThreshold);
        Assert.Equal(70_000, policy.BlockingThreshold);
    }

    [Fact]
    public void InvalidRatioOrder_Throws()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            new BudgetPolicy(1_000_000, softRatio: 0.9, hardRatio: 0.5));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            new BudgetPolicy(1_000_000, hardRatio: 0.95, blockingRatio: 0.8));
    }

    [Fact]
    public void Ratios_AreClampedToUnitInterval()
    {
        // 原始序合法（1.4 < 1.5 < 1.6），clamp 到 [0,1] 后全部为 1.0，且不抛异常。
        var policy = new BudgetPolicy(100_000, marginRatio: 0, outputReserveTokens: 0,
            softRatio: 1.4, hardRatio: 1.5, blockingRatio: 1.6);

        Assert.Equal(1.0, policy.SoftRatio);
        Assert.Equal(1.0, policy.HardRatio);
        Assert.Equal(1.0, policy.BlockingRatio);
    }

    // ---- B_predicted（§6.3）：B_current + B_next-tool-estimate + B_next-output-reserve ----

    [Fact]
    public void Predict_IsSumOfTheThreeTerms()
    {
        Assert.Equal(540_000, BudgetPolicy.Predict(500_000, 30_000, 10_000));
        Assert.Equal(1_000, BudgetPolicy.Predict(0, 0, 1_000));
    }

    [Fact]
    public void PredictsOverSoft_False_BelowThreshold()
    {
        // 500k + 30k + 10k = 540k < 700k soft（margin/output 归零 → B_input = 窗口 1M）→ 不触发。
        var policy = policyWithReserve(1_000_000, nextOutputReserveTokens: 10_000);

        Assert.False(policy.PredictsOverSoft(500_000, 30_000, 10_000));
    }

    [Fact]
    public void PredictsOverSoft_True_WhenSumReachesThreshold()
    {
        // 680k + 20k + 0 = 700k = soft → 触发（暴增场景：长会话已接近水位，单轮大输出越线）。
        var policy = policyWithReserve(1_000_000, nextOutputReserveTokens: 0);

        Assert.True(policy.PredictsOverSoft(680_000, 20_000, 0));
    }

    [Fact]
    public void PredictsOverSoft_UsesPolicyNextOutputReserve_ByDefault()
    {
        // 默认带上策略配置的下一轮输出预留：674k + 20k = 694k < 700k；加配置 reserve 6k → 700k 越线。
        var policy = policyWithReserve(1_000_000, nextOutputReserveTokens: 6_000);

        Assert.False(policy.PredictsOverSoft(674_000, 20_000, 0));
        Assert.True(policy.PredictsOverSoft(674_000, 20_000, policy.NextOutputReserveTokens));
    }

    private static BudgetPolicy policyWithReserve(int window, int nextOutputReserveTokens) =>
        new BudgetPolicy(window, marginRatio: 0, outputReserveTokens: 0, nextOutputReserveTokens: nextOutputReserveTokens);
}