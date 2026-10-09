namespace Core.Skills;

/// <summary>
/// skill 的上下文渲染与成本估算——对齐 MS Agent Framework 渐进式披露的 <b>Advertise</b> 阶段：
/// 每个 skill 只注入一行 name：description（约 100 token/skill），完整指令按需用
/// <see cref="SkillTools.LoadSkillTool"/>（load_skill）加载，避免把全部正文常驻上下文。
/// </summary>
public static class SkillContext
{
    /// <summary>广告块：每个 skill 一行，让模型知道有哪些 skill 可用（load_skill 的候选清单）。</summary>
    public static string BuildAdvertisement(IEnumerable<Skill> skills)
        => string.Join("\n", skills.Select(s => $"- {s.Name}：{s.Description}"));

    /// <summary>
    /// 估算一个回合因 skill 增加的 token：广告块（未激活的 skill，与 <c>AgentRunner</c> 的实际注入一致）
    /// + 激活 skill 的完整指令。粗略按 4 字符/token；用于衡量上下文成本指标。
    /// </summary>
    public static int EstimateTokens(IReadOnlyList<Skill> skills, IReadOnlySet<string> activeNames)
    {
        var chars = BuildAdvertisement(skills.Where(s => !activeNames.Contains(s.Name))).Length;
        foreach (var skill in skills)
        {
            if (activeNames.Contains(skill.Name))
                chars += skill.Name.Length + skill.Instructions.Length;
        }
        return (int)Math.Ceiling(chars / 4.0);
    }
}
