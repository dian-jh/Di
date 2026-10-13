namespace Core.Skills;

/// <summary>一次回合的 skill 激活结果：固定集 + 自动匹配（叠加，固定在前）。</summary>
public sealed record SkillActivationResult(
    IReadOnlyList<Skill> Active,
    IReadOnlyList<Skill> AutoMatched);

/// <summary>
/// 共享的 skill 激活计算：交互 REPL 与 headless 单发对同一条消息要产生相同的激活集。
/// host 用它设置 <c>AgentRunner.ActiveSkills</c>（固定 + 自动匹配，二者可叠加）。
/// 匹配结果每回合重算，不累积；<c>disable-model-invocation</c> 的 skill 由匹配器过滤。
/// </summary>
public static class SkillActivation
{
    public static SkillActivationResult Compute(
        string userMessage, IReadOnlyList<Skill> allSkills, IReadOnlyList<Skill> pinned, ISkillMatcher matcher)
    {
        ArgumentNullException.ThrowIfNull(allSkills);
        ArgumentNullException.ThrowIfNull(pinned);
        ArgumentNullException.ThrowIfNull(matcher);

        var autoMatched = matcher.Match(userMessage, allSkills)
            .Where(m => !pinned.Contains(m.Skill))
            .Select(m => m.Skill)
            .ToList();
        return new SkillActivationResult([.. pinned, .. autoMatched], autoMatched);
    }
}
