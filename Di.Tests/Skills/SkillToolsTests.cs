using Core.AgentLoop;
using Core.Llm;
using Core.Skills;

namespace Di.Tests.Skills;

/// <summary>
/// 针对 <see cref="SkillTools"/>（load_skill 工具定义 + 执行器装饰）的单元测试。
/// load_skill 是渐进式披露的 Load 阶段：模型按名加载完整指令，不常驻全部正文。
/// </summary>
public sealed class SkillToolsTests
{
    private static Skill Skill(string name, string description, string instructions) => new()
    {
        Name = name,
        Description = description,
        Instructions = instructions,
    };

    private static ToolCallBlock LoadCall(string arguments) => new("c1", "load_skill", arguments);

    [Fact]
    public void LoadSkillTool_HasNameAndSchema()
    {
        var tool = SkillTools.LoadSkillTool;

        Assert.Equal("load_skill", tool.Name);
        Assert.True(tool.Parameters["properties"]!["skill_name"] is not null);
    }

    [Fact]
    public void ExecuteLoadSkill_ReturnsInstructions_WhenFound()
    {
        var skills = new[] { Skill("backend-tests", "运行并修复后端测试", "先 build 再 test") }
            .ToDictionary(s => s.Name);

        var result = SkillTools.ExecuteLoadSkill(LoadCall("""{"skill_name":"backend-tests"}"""), skills);

        Assert.Contains("先 build 再 test", result);
        Assert.Contains("backend-tests", result);
    }

    [Fact]
    public void ExecuteLoadSkill_UnknownName_ReturnsError()
    {
        var result = SkillTools.ExecuteLoadSkill(LoadCall("""{"skill_name":"nope"}"""),
            new Dictionary<string, Skill>());

        Assert.StartsWith("error", result);
    }

    [Fact]
    public void ExecuteLoadSkill_MissingOrInvalidArgument_ReturnsError()
    {
        var skills = new Dictionary<string, Skill>();

        Assert.StartsWith("error", SkillTools.ExecuteLoadSkill(LoadCall("{}"), skills));
        Assert.StartsWith("error", SkillTools.ExecuteLoadSkill(LoadCall("not-json"), skills));
    }

    [Fact]
    public async Task SkillAwareExecutor_InterceptsLoadSkill_WithoutTouchingInner()
    {
        var inner = new RecordingExecutor();
        var executor = new SkillAwareExecutor(inner, new[] { Skill("a", "d", "指令 A") });

        var result = await executor.ExecuteAsync(LoadCall("""{"skill_name":"a"}"""));

        Assert.Contains("指令 A", result);
        Assert.Empty(inner.Calls);
    }

    [Fact]
    public async Task SkillAwareExecutor_DelegatesOtherTools_ToInner()
    {
        var inner = new RecordingExecutor();
        var executor = new SkillAwareExecutor(inner, Array.Empty<Skill>());

        await executor.ExecuteAsync(new ToolCallBlock("c1", "bash", "{}"));

        Assert.Single(inner.Calls);
    }

    private sealed class RecordingExecutor : IToolExecutor
    {
        public List<string> Calls { get; } = [];

        public Task<string> ExecuteAsync(ToolCallBlock call, CancellationToken cancellationToken = default)
        {
            Calls.Add(call.Name);
            return Task.FromResult("ok");
        }
    }
}
