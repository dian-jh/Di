namespace Core.Skills;

/// <summary>
/// skill 标准位置（对齐 Agent Skills 规范与 Pi 的 resource-loader / package-manager）：
/// 除 Di 自家的 ~/.di/skills 与 &lt;workspace&gt;/.di/skills 外，还支持
/// <c>~/.agents/skills</c>（用户标准）与 <c>.agents/skills</c>（项目标准，
/// 从工作目录沿祖先目录向上发现，直到 git 仓库根；无 git 则到文件系统根）。
/// 供 <see cref="SkillRepository.Load(IReadOnlyList{string}, Action{string}?)"/> 的调用方
/// （CliHost）按优先级拼装源目录列表。
/// </summary>
public static class SkillLocations
{
    /// <summary>用户级 .agents/skills（Agent Skills 规范位置），位于操作系统家目录下。</summary>
    public static string UserAgentsSkillsDirectory(string homeDirectory)
        => Path.Combine(homeDirectory, ".agents", "skills");

    /// <summary>某目录下的项目级 .agents/skills。</summary>
    public static string ProjectAgentsSkillsDirectory(string directory)
        => Path.Combine(directory, ".agents", "skills");

    /// <summary>
    /// 从 <paramref name="startDirectory"/> 沿祖先目录向上收集 .agents/skills 目录，<b>远 → 近</b>
    /// （git 根在前、startDirectory 在最后）。遇到含 <c>.git</c> 的目录即仓库根，收完该层停止；
    /// 无 git 仓库则直到文件系统根。配合 <see cref="SkillRepository.Load(IReadOnlyList{string}, Action{string}?)"/>
    /// 的"后面的源覆盖前面的"语义，最近（startDirectory 侧）的 .agents/skills 享有最高优先。
    /// </summary>
    public static IReadOnlyList<string> AncestorAgentsSkillDirectories(string startDirectory)
    {
        var dirs = new List<string>();
        var current = Path.GetFullPath(startDirectory);

        string? gitRoot = null;
        for (var probe = current; ; probe = Parent(probe))
        {
            if (Directory.Exists(Path.Combine(probe, ".git")) || File.Exists(Path.Combine(probe, ".git")))
            {
                gitRoot = probe;
                break;
            }
            if (probe.Length == Parent(probe).Length)
                break;
        }

        var stack = new List<string>();
        for (; ; current = Parent(current))
        {
            stack.Add(current);
            if (gitRoot is not null && string.Equals(current, gitRoot, StringComparison.OrdinalIgnoreCase))
                break;
            if (current.Length == Parent(current).Length)
                break;
        }
        for (var i = stack.Count - 1; i >= 0; i--)
            dirs.Add(ProjectAgentsSkillsDirectory(stack[i]));
        return dirs;
    }

    private static string Parent(string dir)
    {
        var parent = Path.GetDirectoryName(dir);
        return string.IsNullOrEmpty(parent) ? dir : parent;
    }
}
