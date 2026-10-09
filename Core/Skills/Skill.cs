namespace Core.Skills;

/// <summary>
/// 一个 Skill：SKILL.md 的 frontmatter 元数据 + 指令正文。
/// 用户写在 ~/.di/skills/&lt;name&gt;/SKILL.md 或 &lt;workspace&gt;/.di/skills/&lt;name&gt;/SKILL.md，
/// 经 <see cref="SkillMarkdown"/> 解析、<see cref="SkillRepository"/> 发现合并。
/// 字段对齐 Microsoft Agent Framework 的 SKILL.md 规范（learn.microsoft.com/agent-framework/agents/skills）。
/// </summary>
public sealed record Skill
{
    /// <summary>
    /// 激活用名称。MS 规范：≤64 字符、仅小写字母/数字/连字符、不得以连字符开头/结尾或含连续连字符、
    /// <b>必须匹配父目录名</b>。
    /// </summary>
    public required string Name { get; init; }

    /// <summary>
    /// 一句话用途（≤1024 字符）："做什么 + 什么时候用"，应包含帮助识别相关任务的
    /// 关键词（自动匹配与 load_skill 的决策都靠它）。
    /// </summary>
    public required string Description { get; init; }

    /// <summary>注入给模型的指令正文（frontmatter 之后的正文，步骤/示例/边界情况）。</summary>
    public required string Instructions { get; init; }

    /// <summary>任意键值元数据（frontmatter 的 metadata 段，可放 author/version 等）。</summary>
    public IReadOnlyDictionary<string, string> Metadata { get; init; } = new Dictionary<string, string>();

    /// <summary>
    /// allowed-tools：该 skill 预批准的工具白名单（MS 规范中为实验性字段）。
    /// 当前仅解析存储；语义（执行前按此过滤）留给权限层实现。
    /// </summary>
    public IReadOnlyList<string> AllowedTools { get; init; } = [];
}
