namespace Core.ContextManagement;

/// <summary>
/// B_current 共享值：AgentRunner 在每次工具执行前按当前轨迹更新，回合末同步裁剪后的记忆。
/// 组合根把读取闭包注入 <see cref="CompactingExecutor"/>，供 L1 预算预测使用。
/// </summary>
public sealed class InputBudgetTracker
{
    /// <summary>当前累计输入 token 估算（非负；尚未估算时为 0）。</summary>
    public int CurrentTokens { get; private set; }

    /// <summary>写入本轮累计输入 token 估算（负值按 0 计，防止污染预算判定）。</summary>
    public void Update(int tokens) => CurrentTokens = Math.Max(0, tokens);
}
