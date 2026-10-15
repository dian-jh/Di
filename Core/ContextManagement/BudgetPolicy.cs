namespace Core.ContextManagement;

/// <summary>
/// L1 是否触发下游压缩的水位线分级（对应 docs/context-compression.md §6.2 三级梯度）。
/// </summary>
public enum Waterline
{
    /// <summary>未达任何阈值（&lt; soft）。</summary>
    Under,

    /// <summary>≥ 软阈值（默认 70% × B_input）：保守清理动作。</summary>
    Soft,

    /// <summary>≥ 硬阈值（默认 80% × B_input）：主动压缩。</summary>
    Hard,

    /// <summary>≥ 阻塞线（默认 90% × B_input）：先压缩成功再继续，否则返回"需缩小任务范围"。</summary>
    Blocking,
}

/// <summary>
/// 上下文预算策略（纯逻辑，无 IO）：B_input 公式 + 三级水位线 + B_predicted 预测判定。
/// 设计契约见 docs/context-compression.md §6。组合根注入，测试直接构造。
/// </summary>
public sealed class BudgetPolicy
{
    /// <summary>B_margin 默认比例：窗口的 10%（随窗口缩放）。</summary>
    public const double DefaultMarginRatio = 0.10;

    /// <summary>B_output 默认预留：给模型输出 / 压缩动作的摘要输出留空间（借鉴 Claude Code 20K 预留）。</summary>
    public const int DefaultOutputReserveTokens = 20_000;

    /// <summary>软阈值默认比例（相对 B_input）。</summary>
    public const double DefaultSoftRatio = 0.70;

    /// <summary>硬阈值默认比例（相对 B_input）。</summary>
    public const double DefaultHardRatio = 0.80;

    /// <summary>阻塞线默认比例（相对 B_input）。</summary>
    public const double DefaultBlockingRatio = 0.90;

    /// <summary>B_window：模型总上下文容量。</summary>
    public int Window { get; }

    /// <summary>B_output：给模型输出预留的 token。</summary>
    public int OutputReserveTokens { get; }

    /// <summary>B_margin：给估算误差 / 动态提示 / 工具定义预留的安全空间（默认窗口 10%）。</summary>
    public int MarginTokens { get; }

    /// <summary>B_input = B_window − B_output − B_margin；窗口小于预留时归零（不为负）。</summary>
    public int InputBudget { get; }

    /// <summary>B_next-output-reserve：B_predicted 里为下一轮输出预留的 token（默认 0，阶段四校准）。</summary>
    public int NextOutputReserveTokens { get; }

    /// <summary>soft 水位线比例（相对 B_input，[0,1]）。</summary>
    public double SoftRatio { get; }

    /// <summary>hard 水位线比例（相对 B_input，[0,1]）。</summary>
    public double HardRatio { get; }

    /// <summary>blocking 水位线比例（相对 B_input，[0,1]）。</summary>
    public double BlockingRatio { get; }

    /// <summary>soft 水位线绝对值（token）。</summary>
    public int SoftThreshold { get; }

    /// <summary>hard 水位线绝对值（token）。</summary>
    public int HardThreshold { get; }

    /// <summary>blocking 水位线绝对值（token）。</summary>
    public int BlockingThreshold { get; }

    public BudgetPolicy(int window, double? marginRatio = null, int? outputReserveTokens = null,
        int? nextOutputReserveTokens = null, double? softRatio = null, double? hardRatio = null,
        double? blockingRatio = null)
    {
        Window = Math.Max(0, window);

        SoftRatio = Clamp01(softRatio ?? DefaultSoftRatio);
        HardRatio = Clamp01(hardRatio ?? DefaultHardRatio);
        BlockingRatio = Clamp01(blockingRatio ?? DefaultBlockingRatio);
        if (SoftRatio > HardRatio || HardRatio > BlockingRatio)
            throw new ArgumentOutOfRangeException(nameof(window),
                $"水位线序必须 soft ≤ hard ≤ blocking（当前 {SoftRatio:F2}/{HardRatio:F2}/{BlockingRatio:F2}）");

        MarginTokens = (int)Math.Round(Window * Clamp01(marginRatio ?? DefaultMarginRatio));
        OutputReserveTokens = outputReserveTokens ?? DefaultOutputReserveTokens;
        NextOutputReserveTokens = Math.Max(0, nextOutputReserveTokens ?? 0);
        InputBudget = Math.Max(0, Window - OutputReserveTokens - MarginTokens);

        SoftThreshold = (int)Math.Round(InputBudget * SoftRatio);
        HardThreshold = (int)Math.Round(InputBudget * HardRatio);
        BlockingThreshold = (int)Math.Round(InputBudget * BlockingRatio);
    }

    /// <summary>
    /// 判定当前累计输入量落在哪级水位线（含边界：inputTokens ≥ 阈值即触发该级）。
    /// </summary>
    public Waterline WaterlineFor(int inputTokens)
    {
        if (inputTokens >= BlockingThreshold)
            return Waterline.Blocking;
        if (inputTokens >= HardThreshold)
            return Waterline.Hard;
        if (inputTokens >= SoftThreshold)
            return Waterline.Soft;
        return Waterline.Under;
    }

    /// <summary>
    /// B_predicted = B_current + B_next-tool-estimate + B_next-output-reserve（§6.3）。
    /// 负输入按 0 计。
    /// </summary>
    public static int Predict(int currentTokens, int nextToolEstimateTokens, int nextOutputReserveTokens)
        => Math.Max(0, currentTokens) + Math.Max(0, nextToolEstimateTokens) + Math.Max(0, nextOutputReserveTokens);

    /// <summary>
    /// 预测性触发判定（§6.3）：B_predicted ≥ soft 水位线即"越线"。
    /// L1 控制点正用此预判：执行后、进轨迹前，结果长度已知，避免先把大输出灌进上下文再压。
    /// </summary>
    public bool PredictsOverSoft(int currentTokens, int nextToolEstimateTokens, int nextOutputReserveTokens)
        => Predict(currentTokens, nextToolEstimateTokens, nextOutputReserveTokens) >= SoftThreshold;

    private static double Clamp01(double value) => Math.Clamp(value, 0.0, 1.0);
}