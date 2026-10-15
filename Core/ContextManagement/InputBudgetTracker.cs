namespace Core.ContextManagement;

/// <summary>
/// B_current 共享 holder（docs/context-compression.md §6.3）：跨回合累计输入 token 的
/// 单一数据源。AgentRunner 每回合裁剪完持久记忆后写入估算值；组合根把 holder 的读取闭包
/// 注入 <see cref="CompactingExecutor"/>，L1 预测判定即可计入"长会话已接近水位线"的当前量，
/// 而不是默认 0（否则 1M 窗口 soft≈616k 下，单点结果长度根本够不到阈值，L1 形同虚设）。
/// </summary>
public sealed class InputBudgetTracker
{
    /// <summary>当前累计输入 token 估算（非负；尚未估算时为 0）。</summary>
    public int CurrentTokens { get; private set; }

    /// <summary>写入本轮累计输入 token 估算（负值按 0 计，防止污染预算判定）。</summary>
    public void Update(int tokens) => CurrentTokens = Math.Max(0, tokens);
}
