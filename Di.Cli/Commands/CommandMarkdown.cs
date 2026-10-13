using System.Text.RegularExpressions;

namespace Di.Cli.Commands;

/// <summary>用户命令文件格式错误（frontmatter 缺失 / description 缺失 / 正文为空）。</summary>
public sealed class CommandFormatException : Exception
{
    public CommandFormatException(string message) : base(message) { }
}

/// <summary>
/// 解析 <c>~/.di/commands/&lt;name&gt;.md</c> 用户命令：<c>---</c> 包裹的 frontmatter + 正文指令模板。
/// 对齐 Pi 的 prompt templates —— frontmatter 只带显示元数据（<c>description</c> 必填、
/// <c>argument-hint</c> 可选），命令名即文件名（frontmatter 不声明 name）。正文即指令，调用时
/// 追加参数运行一个完整回合（由 <see cref="CommandLoader"/> 封装成回合型命令）。
/// 严格性对齐 <c>SkillMarkdown</c>：受识别字段只能出现一次、未知字段忽略、BOM/CRLF 容忍。
/// </summary>
public static class CommandMarkdown
{
    public const int MaxNameLength = 64;
    public const int MaxDescriptionLength = 1024;

    private static readonly Regex ValidNamePattern = new("^[a-z0-9]+(-[a-z0-9]+)*$", RegexOptions.Compiled);

    /// <summary>解析一份命令文件内容；<paramref name="expectedName"/> = 文件名（命令名，必须合法）。</summary>
    public static UserCommand Parse(string content, string expectedName)
    {
        ArgumentNullException.ThrowIfNull(content);
        ArgumentNullException.ThrowIfNull(expectedName);
        if (!IsValidName(expectedName))
            throw new CommandFormatException(
                $"命令名 '{expectedName}' 非法：仅限小写字母/数字/连字符，≤{MaxNameLength} 字符（命令名 = 文件名）。");

        content = content.TrimStart((char)0xFEFF, '\r', '\n');
        var firstLineEnd = content.IndexOf('\n');
        var firstLine = firstLineEnd < 0 ? content : content[..firstLineEnd];
        if (firstLine.TrimEnd('\r') != "---")
            throw new CommandFormatException("命令文件必须以 '---' 开头（YAML frontmatter）。");

        var end = FindFrontmatterEnd(content, firstLineEnd + 1);
        if (end < 0)
            throw new CommandFormatException("未找到 frontmatter 的结束行 '---'。");

        var frontmatter = content[(firstLineEnd + 1)..end];
        string? description = null;
        string? argumentHint = null;
        var seen = new HashSet<string>(StringComparer.Ordinal);   // 受识别字段出现集合 → 重复即拒绝

        foreach (var rawLine in frontmatter.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r');
            if (string.IsNullOrWhiteSpace(line) || line.TrimStart().StartsWith('#'))
                continue;   // 空行 / YAML 注释
            var colon = line.IndexOf(':');
            if (colon <= 0)
                continue;   // 忽略无法解析的行
            var key = line[..colon].Trim();
            var value = line[(colon + 1)..].Trim().Trim('"', '\'');

            if (key is not ("description" or "argument-hint"))
                continue;   // 未知字段忽略（向前兼容）
            if (!seen.Add(key))
                throw new CommandFormatException($"frontmatter 字段 '{key}' 重复出现。");
            if (key == "description")
                description = value;
            else
                argumentHint = value;
        }

        if (string.IsNullOrWhiteSpace(description))
            throw new CommandFormatException("frontmatter 缺少 description。");
        if (description.Length > MaxDescriptionLength)
            throw new CommandFormatException($"description 超过 {MaxDescriptionLength} 字符（当前 {description.Length}）。");

        var body = content[end..].TrimStart('\r', '\n').Trim();
        if (body.Length == 0)
            throw new CommandFormatException("命令文件正文为空（需要指令模板）。");

        return new UserCommand(expectedName, description, argumentHint, body);
    }

    /// <summary>从 start 起找独立成行的 "---"，返回该行末尾索引（不含换行）；找不到返回 -1。</summary>
    private static int FindFrontmatterEnd(string content, int start)
    {
        var pos = start;
        while (pos <= content.Length)
        {
            var nl = content.IndexOf('\n', pos);
            var lineEnd = nl < 0 ? content.Length : nl;
            if (content[pos..lineEnd].TrimEnd('\r') == "---")
                return lineEnd;
            if (nl < 0)
                return -1;
            pos = nl + 1;
        }
        return -1;
    }

    private static bool IsValidName(string name) =>
        name.Length <= MaxNameLength && ValidNamePattern.IsMatch(name);
}

/// <summary>解析后的用户命令（名称 = 文件名，正文即指令模板）。</summary>
public sealed record UserCommand(string Name, string Description, string? ArgumentHint, string Body);