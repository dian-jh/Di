using System.Text;
using System.Text.RegularExpressions;

namespace Core.Tools;

/// <summary>
/// 极简 glob → 正则匹配器。
/// 语义：<c>*</c> 匹配同一目录内任意段，<c>?</c> 匹配单字符，<c>**</c> 跨目录，
/// <c>**/</c> 匹配零或多层目录（因此 <c>**/*.py</c> 也命中根目录的 .py 文件）。
/// 路径统一用 <c>/</c> 分隔。
/// </summary>
internal static class GlobMatcher
{
    public static bool IsMatch(string pattern, string path, bool ignoreCase)
        => ToRegex(pattern, ignoreCase).IsMatch(path);

    public static Regex ToRegex(string pattern, bool ignoreCase)
    {
        // 匹配路径统一用 '/' 分隔；把 Windows 风格的反斜杠（src\*.cs）规范成 '/'，
        // 避免模型按 Windows 习惯写模式时永远匹配不到。
        pattern = pattern.Replace('\\', '/');

        var sb = new StringBuilder("^");
        for (var i = 0; i < pattern.Length; i++)
        {
            var c = pattern[i];
            switch (c)
            {
                case '*':
                    if (i + 1 < pattern.Length && pattern[i + 1] == '*')
                    {
                        i++;
                        if (i + 1 < pattern.Length && pattern[i + 1] == '/')
                        {
                            i++;   // **/ → 零或多层目录
                            sb.Append("(?:.*/)?");
                        }
                        else
                        {
                            sb.Append(".*");
                        }
                    }
                    else
                    {
                        sb.Append("[^/]*");
                    }
                    break;

                case '?':
                    sb.Append("[^/]");
                    break;

                default:
                    sb.Append(Regex.Escape(c.ToString()));
                    break;
            }
        }

        sb.Append('$');
        var options = RegexOptions.CultureInvariant | RegexOptions.Compiled;
        if (ignoreCase)
            options |= RegexOptions.IgnoreCase;
        return new Regex(sb.ToString(), options);
    }
}
