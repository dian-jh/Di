using Core.AgentLoop;
using Core.Llm;
using Core.Skills;

namespace Di.Tests.Skills;

/// <summary>
/// Skills 设计符合性审计——以 Pi 生产级 harness 的 skills 设计为基准
/// （参照 <c>E:\Agent\PI\pi\packages\coding-agent\docs\skills.md</c> 与 <c>src/core/skills.ts</c>）
/// 判断 Di 的 skills 设计是否足够优秀。
///
/// 每个测试编码一条生产级需求：渐进式披露、发现与合并、可移植 frontmatter、显式调用，
/// 以及"skill 打包内置文件（scripts/references/assets）并按目录解析相对路径"等进阶能力。
/// 「生产缺口」组在对应实现补齐前应为红——审计即判断：组内全绿才算足够优秀。
/// </summary>
public sealed class SkillDesignAuditTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("di-skill-audit-").FullName;
    private string UserDir => Path.Combine(_root, "user");
    private string ProjectDir => Path.Combine(_root, "proj");

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { }
    }

    private static Skill Skill(string name, string description, string instructions) => new()
    {
        Name = name,
        Description = description,
        Instructions = instructions,
    };

    private static ToolCallBlock LoadCall(string arguments) => new("c1", "load_skill", arguments);

    // ---- 渐进式披露：先广告名字+描述，任务匹配时按需加载全文 ----

    [Fact]
    public void Advertisement_CarriesNameAndDescriptionOnly_NotFullInstructions()
    {
        // Pi：启动只把每个 skill 的 name/description/path 放进提示词，不加完整指令。
        var skill = Skill("pdf-tools", "提取 PDF 文本与表格", new string('x', 500));

        var ad = SkillContext.BuildAdvertisement([skill]);

        Assert.Contains("pdf-tools", ad);
        Assert.Contains("提取 PDF 文本与表格", ad);
        Assert.DoesNotContain(new string('x', 100), ad);   // 完整指令不进广告块
    }

    [Fact]
    public void LoadSkill_ReturnsFullInstructions_OnDemand()
    {
        // Pi：任务匹配时模型加载完整指令（read 文件 / 本实现的 load_skill）。
        var skills = new[] { Skill("pdf-tools", "提取 PDF", "转换前先读 references/formats.md") }
            .ToDictionary(s => s.Name);

        var result = SkillTools.ExecuteLoadSkill(LoadCall("""{"skill_name":"pdf-tools"}"""), skills);

        Assert.Contains("转换前先读 references/formats.md", result);
    }

    // ---- 发现与合并：目录式 + 扁平式，项目覆盖用户，无效/无描述跳过 ----

    [Fact]
    public void Discovers_DirBasedAndFlatSkills()
    {
        var dir = Path.Combine(UserDir, "pdf-tools");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "SKILL.md"), "---\nname: pdf-tools\ndescription: 提取 PDF\n---\nbody");
        Directory.CreateDirectory(ProjectDir);
        File.WriteAllText(Path.Combine(ProjectDir, "release.md"), "---\nname: release\ndescription: 发布检查\n---\nbody");

        var skills = SkillRepository.Load(UserDir, ProjectDir);

        Assert.Equal(["pdf-tools", "release"], skills.Select(s => s.Name));
    }

    [Fact]
    public void ProjectSkill_OverridesUserSkill_ByName()
    {
        Directory.CreateDirectory(UserDir);
        Directory.CreateDirectory(ProjectDir);
        File.WriteAllText(Path.Combine(UserDir, "deploy.md"), "---\nname: deploy\ndescription: 用户版\n---\nbody");
        File.WriteAllText(Path.Combine(ProjectDir, "deploy.md"), "---\nname: deploy\ndescription: 项目版\n---\nbody");

        var skills = SkillRepository.Load(UserDir, ProjectDir);

        var deploy = Assert.Single(skills);
        Assert.Equal("项目版", deploy.Description);
    }

    [Fact]
    public void InvalidAndUndescribedSkills_AreNotLoaded()
    {
        // Pi：格式错误的 SKILL.md 与无 description 的 skill 不被加载。
        Directory.CreateDirectory(UserDir);
        File.WriteAllText(Path.Combine(UserDir, "broken.md"), "不是合法 skill");
        File.WriteAllText(Path.Combine(UserDir, "nodesc.md"), "---\nname: nodesc\n---\nbody");

        var skills = SkillRepository.Load(UserDir, ProjectDir);

        Assert.Empty(skills);
    }

    // ---- 可移植 frontmatter：规范字段全部被解析或容忍 ----

    [Fact]
    public void Parses_AllPortableFrontmatterFields()
    {
        var md = """
            ---
            name: pdf-tools
            description: 提取 PDF 文本与表格，处理 PDF 时使用
            license: MIT
            compatibility: windows/linux
            metadata:
              author: di-team
            allowed-tools: read_file bash
            disable-model-invocation: false
            ---
            body
            """;

        var skill = SkillMarkdown.Parse(md, expectedName: "pdf-tools");

        Assert.Equal("pdf-tools", skill.Name);
        Assert.Equal("di-team", skill.Metadata["author"]);
        Assert.Equal(["read_file", "bash"], skill.AllowedTools);
        Assert.False(skill.DisableModelInvocation);
    }

    [Fact]
    public void DisabledSkill_ExcludedFromModelSelection_OnlyExplicit()
    {
        // Pi：disable-model-invocation: true 的 skill 只接受显式调用。
        var skill = Skill("pdf-tools", "提取 PDF", "body") with { DisableModelInvocation = true };
        var matcher = new LexicalSkillMatcher();

        Assert.DoesNotContain("pdf-tools", SkillContext.BuildAdvertisement([skill]));
        Assert.Empty(matcher.Match("提取 PDF", [skill]));
    }

    // ---- 生产缺口（审计重点）：对应实现补齐前应为红 ----

    [Fact]
    public void Skill_CarriesItsDirectory_SoBundledFilesResolve()
    {
        // Pi：skill 可打包 scripts/references/assets，模型按 skill 目录解析指令里的相对路径。
        var dir = Path.Combine(UserDir, "pdf-tools");
        Directory.CreateDirectory(Path.Combine(dir, "references"));
        File.WriteAllText(Path.Combine(dir, "SKILL.md"),
            "---\nname: pdf-tools\ndescription: 提取 PDF\n---\n转换前先读 references/formats.md");
        File.WriteAllText(Path.Combine(dir, "references", "formats.md"), "格式说明");

        var skills = SkillRepository.Load(UserDir, ProjectDir);

        var skill = Assert.Single(skills);
        Assert.Equal(dir, skill.Directory);
    }

    [Fact]
    public void LoadSkill_ExposesDirectory_SoBundledFilesResolve()
    {
        // Pi：加载结果带 <location> 与"相对路径以 skill 目录为基准"的提示。
        var skill = Skill("pdf-tools", "提取 PDF", "转换前先读 references/formats.md") with
        {
            Directory = Path.Combine(UserDir, "pdf-tools"),
        };
        var skills = new[] { skill }.ToDictionary(s => s.Name);

        var result = SkillTools.ExecuteLoadSkill(LoadCall("""{"skill_name":"pdf-tools"}"""), skills);

        Assert.Contains(Path.Combine(UserDir, "pdf-tools"), result);
    }

    [Fact]
    public void Discovers_StandardAgentsSkillLocations_WithAncestorDiscovery()
    {
        // 对齐 Pi：~/.agents/skills（用户标准）+ .agents/skills 沿祖先目录向上发现直到 git 根
        // （项目标准，近者优先）。git 根之上的目录不参与发现。
        var agentsHome = Path.Combine(_root, "agents-home");
        var repoRoot = Path.Combine(_root, "repo");
        var deep = Path.Combine(repoRoot, "a", "b");
        Directory.CreateDirectory(deep);
        Directory.CreateDirectory(Path.Combine(repoRoot, ".git"));
        Directory.CreateDirectory(Path.Combine(agentsHome, ".agents", "skills"));
        Directory.CreateDirectory(Path.Combine(repoRoot, ".agents", "skills"));
        Directory.CreateDirectory(Path.Combine(repoRoot, "a", ".agents", "skills"));
        Directory.CreateDirectory(Path.Combine(repoRoot, "a", "b", ".agents", "skills"));
        Directory.CreateDirectory(Path.Combine(_root, ".agents", "skills"));   // git 根之上

        File.WriteAllText(Path.Combine(agentsHome, ".agents", "skills", "global.md"),
            "---\nname: global\ndescription: 全局\n---\nbody");
        File.WriteAllText(Path.Combine(repoRoot, ".agents", "skills", "repo.md"),
            "---\nname: repo\ndescription: 仓库级\n---\nbody");
        File.WriteAllText(Path.Combine(repoRoot, "a", ".agents", "skills", "shared.md"),
            "---\nname: shared\ndescription: 浅层\n---\nbody");
        File.WriteAllText(Path.Combine(repoRoot, "a", "b", ".agents", "skills", "shared.md"),
            "---\nname: shared\ndescription: 深层\n---\nbody");
        File.WriteAllText(Path.Combine(_root, ".agents", "skills", "outside.md"),
            "---\nname: outside\ndescription: git 根之上\n---\nbody");

        var skills = SkillRepository.Load(
            [SkillLocations.UserAgentsSkillsDirectory(agentsHome), .. SkillLocations.AncestorAgentsSkillDirectories(deep)]);

        var names = skills.Select(s => s.Name);
        Assert.Contains("global", names);
        Assert.Contains("repo", names);
        Assert.DoesNotContain("outside", names);            // 祖先发现到 git 根为止
        var shared = Assert.Single(skills, s => s.Name == "shared");
        Assert.Equal("深层", shared.Description);           // 最近的 .agents/skills 优先
    }

    [Fact]
    public void WithinSourceNameCollision_ReportsWarning()
    {
        // Pi：同名冲突保留先发现者并产生告警——Di 至少应上报冲突，不静默覆盖。
        // Di 强制 name 匹配目录名，目录式不可能互相同名；真正会撞名的是目录式与扁平式同名
        // （<root>/deploy/SKILL.md 与 <root>/deploy.md）。
        Directory.CreateDirectory(Path.Combine(UserDir, "deploy"));
        File.WriteAllText(Path.Combine(UserDir, "deploy", "SKILL.md"), "---\nname: deploy\ndescription: A\n---\nbody");
        File.WriteAllText(Path.Combine(UserDir, "deploy.md"), "---\nname: deploy\ndescription: B\n---\nbody");

        var warnings = new List<string>();
        SkillRepository.Load(UserDir, ProjectDir, warn: warnings.Add);

        Assert.Contains(warnings, w => w.Contains("deploy"));
    }
}
