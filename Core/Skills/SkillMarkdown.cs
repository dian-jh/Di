using System.Text.RegularExpressions;

namespace Core.Skills;

/// <summary>SKILL.md 格式错误（frontmatter 缺失 / 必需字段缺失或非法 / 正文为空）。</summary>
public sealed class SkillFormatException : Exception
{
    public SkillFormatException(string message) : base(message) { }
}

/// <summary>
/// 解析 SKILL.md：以 <c>---</c> 包裹的 YAML frontmatter + 正文指令。
/// 字段对齐 Microsoft Agent Framework：<c>name</c>/<c>description</c> 必需，<c>metadata</c>
/// （嵌套缩进键值）、<c>allowed-tools</c>（空格分隔）、<c>license</c>/<c>compatibility</c> 可选。
///
/// 严格性（对齐 MS）：受识别字段必须小写且只能出现一次（重复 → 拒绝加载）；非法格式 → 拒绝；
/// 未知顶层字段忽略（向前兼容）。MVP 只解析单行 / 单层缩进的 <c>key: value</c>。
/// </summary>
public static class SkillMarkdown
{
    public const int MaxNameLength = 64;
    public const int MaxDescriptionLength = 1024;

    private static readonly Regex ValidNamePattern = new("^[a-z0-9]+(-[a-z0-9]+)*$", RegexOptions.Compiled);

    /// <summary>
    /// 解析一份 SKILL.md 内容。若提供 <paramref name="expectedName"/>（父目录名），
    /// 会校验 frontmatter 的 name 与之一致（MS 规范要求）。
    /// </summary>
    public static Skill Parse(string content, string? expectedName = null)
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

        var frontmatter = content[(firstLineEnd + 1)..end];

        string? name = null;
        string? description = null;
        var metadata = new Dictionary<string, string>();
        List<string>? allowedTools = null;
        var seen = new HashSet<string>(StringComparer.Ordinal);   // 受识别字段出现集合 → 重复即拒绝
        var inMetadata = false;

        foreach (var rawLine in frontmatter.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r');
            if (string.IsNullOrWhiteSpace(line))
                continue;
            var trimmed = line.TrimStart();
            if (trimmed.StartsWith('#'))
                continue;   // YAML 注释
            var indent = line.Length - trimmed.Length;

            if (inMetadata)
            {
                if (indent > 0)
                {
                    var mColon = trimmed.IndexOf(':');
                    if (mColon > 0)
                    {
                        var mKey = trimmed[..mColon].Trim();
                        var mValue = trimmed[(mColon + 1)..].Trim().Trim('"', '\'');
                        if (!metadata.ContainsKey(mKey))
                            metadata[mKey] = mValue;   // MS：重复键保留首个并告警（这里静默保留首个）
                    }
                    continue;
                }
                inMetadata = false;
            }

            var colon = trimmed.IndexOf(':');
            if (colon <= 0)
                continue;   // 忽略无法解析的行
            var key = trimmed[..colon].Trim();
            var value = trimmed[(colon + 1)..].Trim().Trim('"', '\'');

            if (key is "name" or "description" or "license" or "compatibility" or "metadata" or "allowed-tools")
            {
                if (!seen.Add(key))
                    throw new SkillFormatException($"frontmatter 字段 '{key}' 重复出现。");
            }

            switch (key)
            {
                case "name":
                    name = value;
                    break;
                case "description":
                    description = value;
                    break;
                case "metadata" when value.Length == 0:
                    inMetadata = true;
                    break;
                case "allowed-tools":
                    allowedTools = value.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
                    break;
                // license / compatibility / 未知字段：忽略（向前兼容）
            }
        }

        if (string.IsNullOrWhiteSpace(name))
            throw new SkillFormatException("frontmatter 缺少 name。");
        if (!IsValidName(name))
            throw new SkillFormatException(
                $"name '{name}' 非法：仅限小写字母/数字/连字符，≤{MaxNameLength} 字符，不得以连字符开头/结尾或含连续连字符。");
        if (expectedName is not null && !string.Equals(name, expectedName, StringComparison.Ordinal))
            throw new SkillFormatException($"name '{name}' 与父目录名 '{expectedName}' 不一致（必须匹配）。");
        if (string.IsNullOrWhiteSpace(description))
            throw new SkillFormatException("frontmatter 缺少 description。");
        if (description.Length > MaxDescriptionLength)
            throw new SkillFormatException($"description 超过 {MaxDescriptionLength} 字符（当前 {description.Length}）。");

        var instructions = content[end..].TrimStart('\r', '\n').Trim();
        if (instructions.Length == 0)
            throw new SkillFormatException("SKILL.md 正文为空。");

        return new Skill
        {
            Name = name,
            Description = description,
            Instructions = instructions,
            Metadata = metadata,
            AllowedTools = allowedTools ?? [],
        };
    }

    private static bool IsValidName(string name) =>
        name.Length <= MaxNameLength && ValidNamePattern.IsMatch(name);

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
