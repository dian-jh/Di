using Core.Skills;

namespace Di.Tests.Skills;

/// <summary>
/// 针对 <see cref="SkillRepository"/>（发现 + 两级合并）的单元测试。
/// 发现规则：&lt;root&gt;/&lt;name&gt;/SKILL.md；项目级覆盖同名用户级。
/// </summary>
public sealed class SkillRepositoryTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("di-skills-").FullName;

    private string UserDir => Path.Combine(_root, "user");
    private string ProjectDir => Path.Combine(_root, "proj");

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { }
    }

    private void WriteSkill(string root, string name, string description, string? frontmatterName = null)
    {
        var dir = Path.Combine(root, name);
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "SKILL.md"),
            $"---\nname: {frontmatterName ?? name}\ndescription: {description}\n---\nbody of {name}");
    }

    [Fact]
    public void Load_ReturnsUserSkills_SortedByName()
    {
        WriteSkill(UserDir, "zebra", "Z 技能");
        WriteSkill(UserDir, "alpha", "A 技能");

        var skills = SkillRepository.Load(UserDir, ProjectDir);

        Assert.Equal(["alpha", "zebra"], skills.Select(s => s.Name));
    }

    [Fact]
    public void Load_ProjectOverridesSameNameUserSkill()
    {
        WriteSkill(UserDir, "deploy", "用户版本");
        WriteSkill(ProjectDir, "deploy", "项目版本");

        var skills = SkillRepository.Load(UserDir, ProjectDir);

        var deploy = Assert.Single(skills);
        Assert.Equal("deploy", deploy.Name);
        Assert.Equal("项目版本", deploy.Description);
    }

    [Fact]
    public void Load_MergesUserAndProjectSkills()
    {
        WriteSkill(UserDir, "user-only", "U");
        WriteSkill(ProjectDir, "proj-only", "P");

        var skills = SkillRepository.Load(UserDir, ProjectDir);

        Assert.Equal(["proj-only", "user-only"], skills.Select(s => s.Name));
    }

    [Fact]
    public void Load_MissingDirectories_ReturnEmpty()
    {
        var skills = SkillRepository.Load(
            Path.Combine(_root, "no-user"), Path.Combine(_root, "no-proj"));

        Assert.Empty(skills);
    }

    [Fact]
    public void Load_SkipsDirectoriesWithoutSkillMd()
    {
        Directory.CreateDirectory(Path.Combine(UserDir, "readme-only"));

        var skills = SkillRepository.Load(UserDir, ProjectDir);

        Assert.Empty(skills);
    }

    [Fact]
    public void Load_SkipsInvalidSkill_AndWarns()
    {
        WriteSkill(UserDir, "good", "ok");
        var badDir = Path.Combine(UserDir, "bad");
        Directory.CreateDirectory(badDir);
        File.WriteAllText(Path.Combine(badDir, "SKILL.md"), "不是合法 skill");

        var warnings = new List<string>();
        var skills = SkillRepository.Load(UserDir, ProjectDir, warn: warnings.Add);

        var good = Assert.Single(skills);
        Assert.Equal("good", good.Name);
        var warning = Assert.Single(warnings);
        Assert.Contains("bad", warning);
    }
}
