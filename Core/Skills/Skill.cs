namespace Core.Skills;

/// <summary>
/// 一个 Skill：SKILL.md 的 frontmatter 元数据 + 指令正文。
/// 用户写在 ~/.di/skills/&lt;name&gt;/SKILL.md 或 &lt;workspace&gt;/.di/skills/&lt;name&gt;/SKILL.md，
/// 经 <see cref="SkillMarkdown"/> 解析、<see cref="SkillRepository"/> 发现合并。
/// </summary>
public sealed record Skill
{
    /// <summary>激活用名称（frontmatter 的 name，也是 /skill 的匹配键）。</summary>
    public required string Name { get; init; }

    /// <summary>一句话用途说明（/skills 列表展示）。</summary>
    public required string Description { get; init; }

    /// <summary>注入给模型的指令正文（frontmatter 之后的正文，逐回合随系统上下文注入）。</summary>
    public required string Instructions { get; init; }
}
