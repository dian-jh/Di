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

    [Fact]
    public void Load_SkipsSkillWhoseNameMismatchesDirectory_AndWarns()
    {
        // frontmatter name 必须匹配父目录名（MS 规范）：目录 foo 里写 name: bar → 跳过并告警。
        var dir = Path.Combine(UserDir, "foo");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "SKILL.md"), "---\nname: bar\ndescription: y\n---\nbody");

        var warnings = new List<string>();
        var skills = SkillRepository.Load(UserDir, ProjectDir, warn: warnings.Add);

        Assert.Empty(skills);
        var warning = Assert.Single(warnings);
        Assert.Contains("foo", warning);
    }

    private void WriteFlatSkill(string root, string name, string description, string? frontmatterName = null)
    {
        Directory.CreateDirectory(root);
        File.WriteAllText(Path.Combine(root, $"{name}.md"),
            $"---\nname: {frontmatterName ?? name}\ndescription: {description}\n---\nbody of {name}");
    }

    [Fact]
    public void Load_LoadsFlatMarkdownFiles_AsSkills()
    {
        // 扁平 <name>.md（对齐 Pi 的 .pi/skills/*.md 惯例）：单文件 skill 无需建目录。
        WriteFlatSkill(UserDir, "release", "发布检查清单");

        var skills = SkillRepository.Load(UserDir, ProjectDir);

        var release = Assert.Single(skills);
        Assert.Equal("release", release.Name);
        Assert.Equal("发布检查清单", release.Description);
    }

    [Fact]
    public void Load_FlatFile_NameMismatch_SkipsAndWarns()
    {
        // 扁平文件 name 必须匹配文件基名（与目录式同一严格性）。
        Directory.CreateDirectory(UserDir);
        File.WriteAllText(Path.Combine(UserDir, "foo.md"),
            "---\nname: bar\ndescription: y\n---\nbody");

        var warnings = new List<string>();
        var skills = SkillRepository.Load(UserDir, ProjectDir, warn: warnings.Add);

        Assert.Empty(skills);
        var warning = Assert.Single(warnings);
        Assert.Contains("foo.md", warning);
    }

    [Fact]
    public void Load_ProjectFlatOverridesUserFlat()
    {
        WriteFlatSkill(UserDir, "release", "用户版本");
        WriteFlatSkill(ProjectDir, "release", "项目版本");

        var skills = SkillRepository.Load(UserDir, ProjectDir);

        var release = Assert.Single(skills);
        Assert.Equal("项目版本", release.Description);
    }

    [Fact]
    public void Load_FlatFileAndDirectory_SameName_FlatWins()
    {
        // 同一来源内目录式与扁平式同名：目录先加载、扁平后加载 → 扁平覆盖（确定性）。
        WriteSkill(UserDir, "deploy", "目录版本");
        WriteFlatSkill(UserDir, "deploy", "扁平版本");

        var skills = SkillRepository.Load(UserDir, ProjectDir);

        var deploy = Assert.Single(skills);
        Assert.Equal("扁平版本", deploy.Description);
    }
}
