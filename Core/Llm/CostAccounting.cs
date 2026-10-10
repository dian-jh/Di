namespace Core.Llm;

/// <summary>
/// 模型成本单价（每百万 token）。生产级模型层必须能回答"这次会话花了多少钱"。
/// 参考 Pi 的 <c>ModelCostRates</c>：输入 / 输出 / 缓存读 / 缓存写各分量独立计价
/// （缓存命中通常显著便宜，混算会高估成本）。
/// 单价来自模型目录（<see cref="ModelSpec.Cost"/>），随模型数据一起维护，不是代码。
/// </summary>
public sealed record ModelCostRates(
    double InputPerMillion,
    double OutputPerMillion,
    double CacheReadPerMillion = 0,
    double CacheWritePerMillion = 0);

/// <summary>
/// 一次调用的成本分解（USD）。<see cref="Total"/> 是四个分量之和。
/// <c>Zero</c> 是聚合累加器的恒等元（<c>Zero.Add(x) == x</c>）。
/// </summary>
public sealed record UsageCost(double Input, double Output, double CacheRead, double CacheWrite)
{
    public double Total => Input + Output + CacheRead + CacheWrite;

    public static UsageCost Zero { get; } = new(0, 0, 0, 0);

    public UsageCost Add(UsageCost other) => new(
        Input + other.Input,
        Output + other.Output,
        CacheRead + other.CacheRead,
        CacheWrite + other.CacheWrite);
}

/// <summary>把 <see cref="TokenUsage"/> 按 <see cref="ModelCostRates"/> 折算成 <see cref="UsageCost"/>。</summary>
public static class CostCalculator
{
    public static UsageCost Calculate(ModelCostRates rates, TokenUsage usage) => new(
        Input: rates.InputPerMillion * usage.InputTokens / 1_000_000,
        Output: rates.OutputPerMillion * usage.OutputTokens / 1_000_000,
        CacheRead: rates.CacheReadPerMillion * (usage.CacheReadTokens ?? 0) / 1_000_000,
        CacheWrite: rates.CacheWritePerMillion * (usage.CacheWriteTokens ?? 0) / 1_000_000);
}
