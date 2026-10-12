namespace Core.Llm;

/// <summary>
/// 文本 token 数的粗略估算（harness 内做<b>上下文预算</b>用，不做精确计费）。
/// 中英文混合按约 4 字符/token，与 <see cref="Core.Skills.SkillContext.EstimateTokens"/> 口径一致。
/// </summary>
public static class TokenEstimator
{
    /// <summary>估算文本的 token 数；null / 空 → 0。粗略按 4 字符/token 向上取整。</summary>
    public static int Estimate(string? text)
        => text is null or "" ? 0 : (int)Math.Ceiling(text.Length / 4.0);
}
