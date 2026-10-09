using System.Text.RegularExpressions;

namespace Core.Skills;

/// <summary>一条 skill 的匹配结果（skill + 相关度）。</summary>
public readonly record struct SkillMatch(Skill Skill, double Relevance);

/// <summary>
/// Skill 匹配器：判断一条用户消息该自动加载哪些 skill（按 name+description 的语义相关度）。
/// 这是"自动激活"的可替换接缝——当前实现是离线词法匹配（无依赖、确定性、可测试），
/// 将来要升级为 embedding 语义匹配时，换一个实现即可，调用方与 ReAct 都不感知。
/// </summary>
public interface ISkillMatcher
{
    /// <summary>返回按相关度降序、高于阈值、数量上限内的匹配。</summary>
    IReadOnlyList<SkillMatch> Match(string userMessage, IReadOnlyList<Skill> skills);
}

/// <summary>
/// 词法匹配器：把用户消息与每个 skill 的 name+description 分词（ASCII 单词 + 中文二元组），
/// 用 Dice 系数算重叠度，低于 <see cref="MinRelevance"/> 的过滤、超过 <see cref="MaxMatches"/> 的截断。
/// 轻量、离线；中英混杂的转述匹配能力弱于 embedding 方案（那是升级路径，见 <see cref="ISkillMatcher"/>）。
/// </summary>
public sealed class LexicalSkillMatcher : ISkillMatcher
{
    /// <summary>自动激活的最低相关度（Dice 系数，0~1）。</summary>
    public double MinRelevance { get; init; } = 0.20;

    /// <summary>单条消息最多自动激活几个（防止描述宽泛的 skill 误伤一片）。</summary>
    public int MaxMatches { get; init; } = 3;

    private static readonly HashSet<string> StopWords = new(StringComparer.Ordinal)
    {
        "the", "a", "an", "is", "are", "was", "to", "for", "of", "on", "in", "with", "and", "or",
        "this", "that", "my", "your", "me", "please", "help", "do", "does", "can", "how", "what",
    };

    public IReadOnlyList<SkillMatch> Match(string userMessage, IReadOnlyList<Skill> skills)
    {
        if (string.IsNullOrWhiteSpace(userMessage) || skills is null || skills.Count == 0)
            return [];

        var msgTokens = Tokenize(userMessage);
        if (msgTokens.Count == 0)
            return [];

        var matches = new List<SkillMatch>();
        foreach (var skill in skills)
        {
            var skillTokens = Tokenize($"{skill.Name} {skill.Description}");
            var relevance = Dice(msgTokens, skillTokens);
            if (relevance >= MinRelevance)
                matches.Add(new SkillMatch(skill, relevance));
        }

        return matches
            .OrderByDescending(m => m.Relevance)
            .ThenBy(m => m.Skill.Name, StringComparer.Ordinal)
            .Take(MaxMatches)
            .ToList();
    }

    /// <summary>分词：ASCII 单词（小写、去停用词）+ 中文相邻字符二元组（不依赖分词器）。</summary>
    private static HashSet<string> Tokenize(string text)
    {
        var tokens = new HashSet<string>(StringComparer.Ordinal);
        foreach (Match m in Regex.Matches(text, @"[A-Za-z0-9]+"))
        {
            var word = m.Value.ToLowerInvariant();
            if (word.Length < 2 || StopWords.Contains(word))
                continue;
            tokens.Add(word);
        }
        AddCjkBigrams(text, tokens);
        return tokens;
    }

    private static void AddCjkBigrams(string text, HashSet<string> tokens)
    {
        char prev = '\0';
        foreach (var ch in text)
        {
            if (ch >= 0x4E00 && ch <= 0x9FFF)   // CJK 统一表意文字
            {
                if (prev != '\0')
                    tokens.Add(string.Concat(prev, ch));
                prev = ch;
            }
            else
            {
                prev = '\0';
            }
        }
    }

    private static double Dice(HashSet<string> a, HashSet<string> b)
    {
        if (a.Count == 0 || b.Count == 0)
            return 0;
        var overlap = 0;
        foreach (var token in a)
            if (b.Contains(token))
                overlap++;
        return 2.0 * overlap / (a.Count + b.Count);
    }
}
