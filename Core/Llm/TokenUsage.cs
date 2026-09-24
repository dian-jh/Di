namespace Core.Llm;

/// <summary>
/// 一次模型调用的 token 计量。
/// 参考 DSH：计数是<b>互斥</b>的 —— inputTokens 是未命中缓存的输入；
/// 缓存命中的输入单独报为 CacheReadTokens/CacheWriteTokens（计费输入 = 三者之和）。
/// 适配器把提供方折叠进总 prompt 数的缓存命中（如 DeepSeek 的 prompt_tokens）拆出来。
/// </summary>
public sealed record TokenUsage(
    int InputTokens,
    int OutputTokens,
    int? TotalTokens = null,
    int? CacheReadTokens = null,
    int? CacheWriteTokens = null,
    int? ReasoningTokens = null)
{
    /// <summary>计费输入 = 未命中 + 命中读取 + 命中写入。</summary>
    public int BillableInputTokens =>
        InputTokens + (CacheReadTokens ?? 0) + (CacheWriteTokens ?? 0);

    public static TokenUsage Zero { get; } = new(0, 0);

    public TokenUsage Add(TokenUsage other) => new(
        InputTokens + other.InputTokens,
        OutputTokens + other.OutputTokens,
        TotalTokens is null || other.TotalTokens is null ? null : TotalTokens + other.TotalTokens,
        CacheReadTokens is null || other.CacheReadTokens is null ? null : CacheReadTokens + other.CacheReadTokens,
        CacheWriteTokens is null || other.CacheWriteTokens is null ? null : CacheWriteTokens + other.CacheWriteTokens,
        ReasoningTokens is null || other.ReasoningTokens is null ? null : ReasoningTokens + other.ReasoningTokens);

    public override string ToString() =>
        $"in={InputTokens} (cache_read={CacheReadTokens ?? 0}) out={OutputTokens} (reasoning={ReasoningTokens ?? 0}) total={TotalTokens ?? BillableInputTokens + OutputTokens}";
}
