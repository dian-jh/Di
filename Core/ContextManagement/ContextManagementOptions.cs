namespace Core.ContextManagement;

/// <summary>
/// 上下文压缩系统（Core.ContextManagement）配置。由组合根从 "ContextManagement" 配置段绑定
/// （docs/context-compression.md §6 预算公式 / §9 阶段一；分层配置规范见 docs/di-home.md §3.1）。
/// 阶段一落地 L1（工具结果预算控制）+ BudgetPolicy；L2-L5 随阶段二/三上线。
/// </summary>
public sealed class ContextManagementOptions
{
    /// <summary>
    /// 总开关（ContextManagement:Enabled）。默认 true：组合根把执行器包一层 CompactingExecutor；
    /// false = 执行器原样通过（回退压缩前行为）。窗口解析失败 / headless 无会话上下文时同样回退。
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>B_margin 比例（窗口的 10% 默认，§6.1）；随窗口缩放。</summary>
    public double? MarginRatio { get; set; }

    /// <summary>B_output 预留 token（默认 20_000，§6.1）。</summary>
    public int? OutputReserveTokens { get; set; }

    /// <summary>B_next-output-reserve（B_predicted 第三项，默认 0，阶段四校准，§6.3）。</summary>
    public int? NextOutputReserveTokens { get; set; }

    /// <summary>soft 水位线比例（默认 0.70，相对 B_input，§6.2）。</summary>
    public double? SoftRatio { get; set; }

    /// <summary>hard 水位线比例（默认 0.80，相对 B_input，§6.2）。</summary>
    public double? HardRatio { get; set; }

    /// <summary>blocking 水位线比例（默认 0.90，相对 B_input，§6.2）。</summary>
    public double? BlockingRatio { get; set; }
}