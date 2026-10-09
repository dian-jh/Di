using Core.Skills;

namespace Di.Tests.Skills;

/// <summary>
/// 针对 <see cref="LexicalSkillMatcher"/>（自动匹配：用户消息 × skill 描述）的单元测试。
/// 中文用相邻字符二元组、英文用单词分词，Dice 系数判相关度。
/// </summary>
public sealed class SkillMatcherTests
{
    private static Skill Skill(string name, string description) => new()
    {
        Name = name,
        Description = description,
        Instructions = "instructions",
    };

    [Fact]
    public void Match_ChineseRelevantSkill_IsReturned()
    {
        var skill = Skill("backend-tests", "运行并修复后端测试");
        var matcher = new LexicalSkillMatcher();

        var matches = matcher.Match("运行测试", [skill]);

        var match = Assert.Single(matches);
        Assert.Same(skill, match.Skill);
        Assert.True(match.Relevance >= 0.20, $"相关度过低: {match.Relevance}");
    }

    [Fact]
    public void Match_EnglishRelevantSkill_IsReturned()
    {
        var skill = Skill("deploy", "Run the backend tests and fix failures");
        var matcher = new LexicalSkillMatcher();

        var matches = matcher.Match("run backend tests", [skill]);

        Assert.Single(matches);
    }

    [Fact]
    public void Match_UnrelatedMessage_ReturnsEmpty()
    {
        var skill = Skill("backend-tests", "运行并修复后端测试");
        var matcher = new LexicalSkillMatcher();

        var matches = matcher.Match("今天天气不错，随便聊聊", [skill]);

        Assert.Empty(matches);
    }

    [Fact]
    public void Match_RespectsMinRelevance()
    {
        var skill = Skill("backend-tests", "运行并修复后端测试");
        var matcher = new LexicalSkillMatcher { MinRelevance = 0.9 };

        var matches = matcher.Match("运行测试", [skill]);

        Assert.Empty(matches);
    }

    [Fact]
    public void Match_RespectsMaxMatches()
    {
        var skills = new[]
        {
            Skill("a", "运行并修复后端测试"),
            Skill("b", "运行后端测试并检查覆盖率"),
            Skill("c", "运行测试并修复失败用例"),
            Skill("d", "运行测试套件并输出报告"),
        };
        var matcher = new LexicalSkillMatcher { MaxMatches = 3 };

        var matches = matcher.Match("运行测试", skills);

        Assert.Equal(3, matches.Count);
    }

    [Fact]
    public void Match_OrdersByRelevanceDescending()
    {
        var relevant = Skill("backend-tests", "运行并修复后端测试");
        var unrelated = Skill("deploy", "部署到生产环境并执行迁移");
        var matcher = new LexicalSkillMatcher();

        var matches = matcher.Match("运行测试", [unrelated, relevant]);

        Assert.Equal("backend-tests", matches[0].Skill.Name);
    }

    [Fact]
    public void Match_EmptyOrNullInput_ReturnsEmpty()
    {
        var skill = Skill("backend-tests", "运行并修复后端测试");
        var matcher = new LexicalSkillMatcher();

        Assert.Empty(matcher.Match("", [skill]));
        Assert.Empty(matcher.Match("   ", [skill]));
        Assert.Empty(matcher.Match(null!, [skill]));
        Assert.Empty(matcher.Match("运行测试", []));
        Assert.Empty(matcher.Match("运行测试", null!));
    }

    [Fact]
    public void Match_EnglishStopWords_DoNotDistortScoring()
    {
        var skill = Skill("deploy", "Deploy the app to production with migrations");
        var matcher = new LexicalSkillMatcher();

        // "the / to / with" 等停用词不计入，避免无意义的重叠拉高相关度。
        var matches = matcher.Match("what is the weather", [skill]);

        Assert.Empty(matches);
    }
}
