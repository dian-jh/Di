using Core.Skills;

namespace Di.Tests.Skills;

/// <summary>
/// <see cref="SkillActivation"/> 的单元测试：REPL 与 headless 单发共享的"固定集 + 自动匹配"计算。
/// 固定集不受自动匹配影响、二者可叠加；匹配结果每回合重算，不累积。
/// </summary>
public sealed class SkillActivationTests
{
    private static readonly Skill BackendTests = new()
    {
        Name = "backend-tests",
        Description = "运行并修复后端测试（dotnet）。当用户要求运行测试、分析失败或修复测试时使用。",
        Instructions = "1. dotnet build\n2. dotnet test",
    };

    private static readonly Skill Chat = new()
    {
        Name = "chat",
        Description = "普通闲聊与答疑。当用户只是聊天、提问常识或闲聊时使用。",
        Instructions = "正常回答。",
    };

    private static readonly Skill Disabled = new()
    {
        Name = "deploy",
        Description = "部署发布（只接受显式 /skill 调用）。当用户要求部署、发布或上线时使用。",
        Instructions = "部署流程。",
        DisableModelInvocation = true,
    };

    [Fact]
    public void Compute_NoSkills_ReturnsEmpty()
    {
        var result = SkillActivation.Compute("跑一下后端测试", [], [], new LexicalSkillMatcher());

        Assert.Empty(result.Active);
        Assert.Empty(result.AutoMatched);
    }

    [Fact]
    public void Compute_MatchingMessage_AutoActivatesSkill()
    {
        var result = SkillActivation.Compute("跑一下后端测试", [BackendTests, Chat], [], new LexicalSkillMatcher());

        Assert.Equal(["backend-tests"], result.AutoMatched.Select(s => s.Name));
        Assert.Equal(["backend-tests"], result.Active.Select(s => s.Name));
    }

    [Fact]
    public void Compute_NoMatch_ReturnsEmpty()
    {
        var result = SkillActivation.Compute("随便聊聊", [BackendTests, Chat], [], new LexicalSkillMatcher());

        Assert.Empty(result.AutoMatched);
        Assert.Empty(result.Active);
    }

    [Fact]
    public void Compute_PinnedSkill_NotDuplicatedInAutoMatched()
    {
        // 固定集（/skill 手动激活）已覆盖同一 skill：自动匹配要排除它，避免重复。
        var result = SkillActivation.Compute("跑一下后端测试", [BackendTests, Chat], [BackendTests], new LexicalSkillMatcher());

        Assert.Equal(["backend-tests"], result.Active.Select(s => s.Name));
        Assert.Empty(result.AutoMatched);
    }

    [Fact]
    public void Compute_PinnedPlusAutoMatched_Combined()
    {
        // 固定集与自动匹配叠加：固定在前，自动匹配的附加在后。
        var result = SkillActivation.Compute("跑一下后端测试", [BackendTests, Chat], [Chat], new LexicalSkillMatcher());

        Assert.Equal(["chat", "backend-tests"], result.Active.Select(s => s.Name));
        Assert.Equal(["backend-tests"], result.AutoMatched.Select(s => s.Name));
    }

    [Fact]
    public void Compute_DisabledModelInvocationSkill_NotAutoMatched()
    {
        // disable-model-invocation 的 skill 只接受显式 /skill，不进自动匹配（matcher 已过滤）。
        var result = SkillActivation.Compute("帮我部署上线", [Disabled, Chat], [], new LexicalSkillMatcher());

        Assert.Empty(result.AutoMatched);
        Assert.Empty(result.Active);
    }
}
