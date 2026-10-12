namespace Core.Skills;

/// <summary>
/// Skill 仓库：发现 + 合并。两级来源——用户级（~/.di/skills）与项目级（&lt;workspace&gt;/.di/skills），
/// 项目级覆盖同名用户级（与配置分层同一心智：具体环境优先）。
/// 无效 skill（解析失败 / 读盘失败）跳过并回调告警，绝不让启动失败。
/// 设计文档见 docs/modules/skills.md。
/// </summary>
public static class SkillRepository
{
    /// <summary>
    /// 加载全部 skill，按名称排序返回。发现规则：&lt;root&gt;/&lt;name&gt;/SKILL.md（MS 规范目录式）
    /// 或 &lt;root&gt;/&lt;name&gt;.md（扁平式，对齐 Pi 的 .pi/skills/*.md 惯例）。
    /// frontmatter 的 name 必须与父目录名 / 文件基名一致，否则该 skill 跳过并告警。
    /// <paramref name="warn"/> 用于上报无效条目（null = 静默跳过）。
    /// </summary>
    public static IReadOnlyList<Skill> Load(string userDirectory, string projectDirectory, Action<string>? warn = null)
    {
        var skills = new Dictionary<string, Skill>(StringComparer.Ordinal);
        LoadInto(userDirectory, skills, warn);
        LoadInto(projectDirectory, skills, warn);   // 项目覆盖同名用户级
        return skills.Values.OrderBy(s => s.Name, StringComparer.Ordinal).ToList();
    }

    private static void LoadInto(string skillsRoot, Dictionary<string, Skill> into, Action<string>? warn)
    {
        if (!Directory.Exists(skillsRoot))
            return;
        foreach (var dir in Directory.EnumerateDirectories(skillsRoot))
        {
            var markdown = Path.Combine(dir, "SKILL.md");
            if (!File.Exists(markdown))
                continue;   // 目录下没有 SKILL.md 就不是 skill
            try
            {
                var skill = SkillMarkdown.Parse(File.ReadAllText(markdown), expectedName: Path.GetFileName(dir));
                into[skill.Name] = skill;
            }
            catch (Exception ex) when (ex is SkillFormatException or IOException or UnauthorizedAccessException)
            {
                warn?.Invoke($"跳过无效 skill {markdown}: {ex.Message}");
            }
        }

        // 扁平 <name>.md（对齐 Pi 的 .pi/skills/*.md 惯例）：单文件 skill 无需建目录。
        // 目录式先加载、扁平式后加载：同源同名时扁平覆盖目录式（顺序确定性，见 SkillRepository 文档）。
        foreach (var file in Directory.EnumerateFiles(skillsRoot, "*.md"))
        {
            try
            {
                var skill = SkillMarkdown.Parse(File.ReadAllText(file), expectedName: Path.GetFileNameWithoutExtension(file));
                into[skill.Name] = skill;
            }
            catch (Exception ex) when (ex is SkillFormatException or IOException or UnauthorizedAccessException)
            {
                warn?.Invoke($"跳过无效 skill {file}: {ex.Message}");
            }
        }
    }
}
