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
/// 用<b>重叠系数</b>（重叠 token ÷ 较短一方的 token 数）算相关度——长查询与长描述都不会被稀释
/// （查询覆盖率的分母是完整查询长度，口语化长消息的填充词会把它稀释到阈值以下导致漏匹配）。
/// 低于 <see cref="MinRelevance"/> 的过滤、超过 <see cref="MaxMatches"/> 的截断。轻量、离线、
/// 确定性、可测试；中英混杂的转述匹配能力弱于 embedding 方案（那是升级路径，见 <see cref="ISkillMatcher"/>）。
/// </summary>
public sealed class LexicalSkillMatcher : ISkillMatcher
{
    /// <summary>自动激活的最低相关度（查询覆盖率，0~1）。</summary>
    public double MinRelevance { get; init; } = 0.30;

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
            if (skill.DisableModelInvocation)
                continue;   // 只接受显式 /skill 调用，不进自动匹配
            var skillTokens = Tokenize($"{skill.Name} {skill.Description}");
            var relevance = OverlapCoefficient(msgTokens, skillTokens);
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

    /// <summary>
    /// 重叠系数 = |查询 ∩ skill| / min(|查询|, |skill|)：两端都不稀释。
    /// 查询覆盖率的弱点是以完整查询长度为分母——口语化长消息里的填充词把得分稀释到阈值以下，
    /// 该命中的 skill 会漏掉（"今天能不能帮我运行一下后端的测试用例" 只重叠 3/16）。
    /// 用较短一方做分母后，长查询与长描述都不再稀释，且确定性/可测试性保持不变。
    /// </summary>
    private static double OverlapCoefficient(HashSet<string> query, HashSet<string> skill)
    {
        if (query.Count == 0 || skill.Count == 0)
            return 0;
        var overlap = 0;
        foreach (var token in query)
            if (skill.Contains(token))
                overlap++;
        return (double)overlap / Math.Min(query.Count, skill.Count);
    }
}
