namespace Core.Skills;

/// <summary>一次带标签的匹配用例：用户消息 + 应该命中的 skill 名（用于触发/排除测试）。</summary>
public sealed record SkillTestCase(string Message, IReadOnlyList<string> ExpectedSkills);

/// <summary>匹配器在带标签用例集上的质量与成本指标。</summary>
public sealed record SkillMetrics(
    double Precision,         // 精确率：激活的 skill 中有多少确实应该激活
    double Recall,            // 召回率：应该激活的 skill 中有多少被成功选中
    double NoMatchRate,       // 无匹配率：有多少任务没匹配到任何 skill
    double AverageContextTokens);   // 上下文成本：每回合 skill 相关的平均估算 token

/// <summary>
/// 在带标签用例集上评估匹配器。三分类验收指标：
/// 触发测试 = 用例 ExpectedSkills 非空且被命中（贡献精确/召回）；
/// 排除测试 = 用例 ExpectedSkills 为空且不应被命中（贡献无匹配率）；
/// 执行测试 = 超出匹配器范围，按 skill 实际工作流单独验证。
/// </summary>
public static class SkillEvaluator
{
    public static SkillMetrics Evaluate(
        ISkillMatcher matcher, IReadOnlyList<Skill> skills, IReadOnlyList<SkillTestCase> cases)
    {
        var activated = 0;
        var correct = 0;
        var expected = 0;
        var noMatch = 0;
        var contextTokens = 0.0;

        foreach (var tc in cases)
        {
            var hit = matcher.Match(tc.Message, skills).Select(m => m.Skill.Name).ToHashSet();
            var want = tc.ExpectedSkills.ToHashSet();
            activated += hit.Count;
            correct += hit.Intersect(want).Count();
            expected += want.Count;
            if (hit.Count == 0)
                noMatch++;
            contextTokens += SkillContext.EstimateTokens(skills, hit);
        }

        return new SkillMetrics(
            Precision: activated == 0 ? 0 : (double)correct / activated,
            Recall: expected == 0 ? 0 : (double)correct / expected,
            NoMatchRate: cases.Count == 0 ? 0 : (double)noMatch / cases.Count,
            AverageContextTokens: cases.Count == 0 ? 0 : contextTokens / cases.Count);
    }
}
