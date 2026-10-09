using Core.Skills;

namespace Di.Tests.Skills;

/// <summary>
/// 针对 <see cref="SkillEvaluator"/>（匹配器质量与成本指标）的单元测试。
/// 触发测试（应命中）、排除测试（不应命中）、精确率/召回率/无匹配率/上下文成本。
/// </summary>
public sealed class SkillEvaluatorTests
{
    private static Skill Skill(string name, string description) => new()
    {
        Name = name,
        Description = description,
        Instructions = "指令正文",
    };

    private static readonly IReadOnlyList<Skill> TwoSkills =
    [
        Skill("backend-tests", "运行并修复后端测试"),
        Skill("deploy", "部署到生产环境"),
    ];

    [Fact]
    public void Evaluate_PerfectMatcher_PrecisionAndRecallAreOne()
    {
        var cases = new[]
        {
            new SkillTestCase("运行测试", ["backend-tests"]),
            new SkillTestCase("部署到生产", ["deploy"]),
            new SkillTestCase("今天天气如何", []),   // 排除测试：不应命中任何 skill
        };

        var metrics = SkillEvaluator.Evaluate(new LexicalSkillMatcher(), TwoSkills, cases);

        Assert.Equal(1.0, metrics.Precision);
        Assert.Equal(1.0, metrics.Recall);
        Assert.Equal(1.0 / 3.0, metrics.NoMatchRate, 5);
        Assert.True(metrics.AverageContextTokens > 0, "每回合应有非零的 skill 上下文成本");
    }

    [Fact]
    public void Evaluate_OverActivation_LowersPrecision()
    {
        var skills = new[]
        {
            Skill("a", "运行并修复后端测试"),
            Skill("b", "运行测试并检查覆盖率"),
        };
        var cases = new[] { new SkillTestCase("运行测试", ["a"]) };   // 期望只命中 a，实际 a+b 都命中

        var metrics = SkillEvaluator.Evaluate(new LexicalSkillMatcher(), skills, cases);

        Assert.Equal(0.5, metrics.Precision);   // 2 个激活，1 个正确
        Assert.Equal(1.0, metrics.Recall);
    }

    [Fact]
    public void Evaluate_AllUnrelated_NoMatchRateIsOne()
    {
        var cases = new[]
        {
            new SkillTestCase("今天天气不错", []),
            new SkillTestCase("随便聊聊", []),
        };

        var metrics = SkillEvaluator.Evaluate(new LexicalSkillMatcher(), TwoSkills, cases);

        Assert.Equal(1.0, metrics.NoMatchRate);
        Assert.Equal(0.0, metrics.Precision);
        Assert.Equal(0.0, metrics.Recall);
    }

    [Fact]
    public void EstimateTokens_GrowsWhenSkillsAreActive()
    {
        // 激活 = 广告行换成完整正文；正文比广告行长时成本上升（广告块会跳过已激活 skill）。
        var skills = new[]
        {
            Skill("backend-tests", "运行并修复后端测试") with { Instructions = new string('x', 200) },
            Skill("deploy", "部署到生产环境"),
        };
        var idle = SkillContext.EstimateTokens(skills, new HashSet<string>());
        var active = SkillContext.EstimateTokens(skills, new HashSet<string> { "backend-tests" });

        Assert.True(idle > 0);
        Assert.True(active > idle, "激活长正文 skill 应比纯广告块更耗上下文");
    }
}
