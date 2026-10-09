namespace Core.Skills;

/// <summary>SKILL.md 格式错误（frontmatter 缺失 / 必需字段缺失 / 正文为空）。</summary>
public sealed class SkillFormatException : Exception
{
    public SkillFormatException(string message) : base(message) { }
}

/// <summary>
/// 解析 SKILL.md：以 <c>---</c> 包裹的 YAML frontmatter（必需字段 <c>name</c> / <c>description</c>）
/// + 正文指令。对齐 Claude Code 的 SKILL.md 约定，社区 skill 可直接迁移。
/// MVP 只解析单行 <c>key: value</c>（忽略多行标量等 YAML 复杂语法）。
/// </summary>
public static class SkillMarkdown
{
    public static Skill Parse(string content)
    {
        ArgumentNullException.ThrowIfNull(content);

        // 容忍 BOM 与前导空行。
        content = content.TrimStart((char)0xFEFF, '\r', '\n');

        var firstLineEnd = content.IndexOf('\n');
        var firstLine = firstLineEnd < 0 ? content : content[..firstLineEnd];
        if (firstLine.TrimEnd('\r') != "---")
            throw new SkillFormatException("SKILL.md 必须以 '---' 开头（YAML frontmatter）。");

        var end = FindFrontmatterEnd(content, firstLineEnd + 1);
        if (end < 0)
            throw new SkillFormatException("未找到 frontmatter 的结束行 '---'。");

        string? name = null;
        string? description = null;
        foreach (var rawLine in content[(firstLineEnd + 1)..end].Split('\n'))
        {
            var line = rawLine.TrimEnd('\r').Trim();
            if (line.Length == 0)
                continue;
            var colon = line.IndexOf(':');
            if (colon <= 0)
                continue;   // 忽略无法解析的行
            var key = line[..colon].Trim();
            var value = line[(colon + 1)..].Trim().Trim('"', '\'');
            if (key == "name")
                name = value;
            else if (key == "description")
                description = value;
        }

        if (string.IsNullOrWhiteSpace(name))
            throw new SkillFormatException("frontmatter 缺少 name。");
        if (string.IsNullOrWhiteSpace(description))
            throw new SkillFormatException("frontmatter 缺少 description。");

        var instructions = content[end..].TrimStart('\r', '\n').Trim();
        if (instructions.Length == 0)
            throw new SkillFormatException("SKILL.md 正文为空。");

        return new Skill { Name = name, Description = description, Instructions = instructions };
    }

    /// <summary>从 start 起找独立成行的 "---"，返回该行末尾索引（不含换行）；找不到返回 -1。</summary>
    private static int FindFrontmatterEnd(string content, int start)
    {
        var pos = start;
        while (pos <= content.Length)
        {
            var nl = content.IndexOf('\n', pos);
            var lineEnd = nl < 0 ? content.Length : nl;
            var line = content[pos..lineEnd].TrimEnd('\r');
            if (line == "---")
                return lineEnd;
            if (nl < 0)
                return -1;
            pos = nl + 1;
        }
        return -1;
    }
}
