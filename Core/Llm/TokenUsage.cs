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
        SumOrNull(TotalTokens, other.TotalTokens),
        SumOrNull(CacheReadTokens, other.CacheReadTokens),
        SumOrNull(CacheWriteTokens, other.CacheWriteTokens),
        SumOrNull(ReasoningTokens, other.ReasoningTokens));

    /// <summary>
    /// 可空字段的累加：单侧为 null（未上报/初始 Zero）时保留另一侧，避免
    /// <c>TokenUsage.Zero.Add(x)</c> 把 x 的缓存/推理字段折叠成 null；
    /// 两侧都有值才求和。null 语义是"未上报"，不是 0，因此不抹掉已知数据。
    /// </summary>
    private static int? SumOrNull(int? a, int? b) =>
        a is null ? b : b is null ? a : a + b;

    public override string ToString() =>
        $"in={InputTokens} (cache_read={CacheReadTokens ?? 0}) out={OutputTokens} (reasoning={ReasoningTokens ?? 0}) total={TotalTokens ?? BillableInputTokens + OutputTokens}";
}
