using System.Text.Json;
using Core.AgentLoop;
using Core.Llm;
using Core.Tools;

namespace Core.Skills;

/// <summary>
/// skill 的模型可见工具（对齐 MS Agent Framework 的 <c>load_skill</c>）：
/// 模型在广告块里看到 skill 清单，需要时按名加载完整指令，而不是常驻全部正文。
/// </summary>
public static class SkillTools
{
    /// <summary>模型按需加载 skill 完整指令的工具定义。</summary>
    public static ChatTool LoadSkillTool { get; } = ChatTool.Create(
        "load_skill",
        "按名称加载一个已列出 skill 的完整指令正文。当任务匹配某个可用 skill 时调用，不要凭空调用。",
        ToolHelpers.Schema(("skill_name", "string", "要加载的 skill 名称（来自可用 skills 列表）")));

    public static bool IsLoadSkillCall(ToolCallBlock call) => call.Name == "load_skill";

    /// <summary>执行 load_skill：返回 skill 的完整指令；未知名称 / 参数缺失返回错误观察。</summary>
    public static string ExecuteLoadSkill(ToolCallBlock call, IReadOnlyDictionary<string, Skill> skills)
    {
        string name;
        try
        {
            using var doc = JsonDocument.Parse(call.Arguments);
            if (!doc.RootElement.TryGetProperty("skill_name", out var prop) ||
                string.IsNullOrWhiteSpace(prop.GetString()))
            {
                return "error: 缺少参数 skill_name";
            }
            name = prop.GetString()!;
        }
        catch (JsonException)
        {
            return "error: arguments 不是合法 JSON";
        }

        return skills.TryGetValue(name, out var skill)
            ? $"【Skill：{skill.Name}】{skill.Description}\n\n{skill.Instructions}"
            : $"error: 未找到 skill '{name}'（可用列表见系统上下文）";
    }
}

/// <summary>执行器装饰器：拦截 load_skill 调用，其余委托给内层执行器。</summary>
public sealed class SkillAwareExecutor : IToolExecutor
{
    private readonly IToolExecutor _inner;
    private readonly IReadOnlyDictionary<string, Skill> _skills;

    public SkillAwareExecutor(IToolExecutor inner, IEnumerable<Skill> skills)
    {
        _inner = inner ?? throw new ArgumentNullException(nameof(inner));
        _skills = skills.ToDictionary(s => s.Name, StringComparer.Ordinal);
    }

    public Task<string> ExecuteAsync(ToolCallBlock call, CancellationToken cancellationToken = default)
    {
        if (SkillTools.IsLoadSkillCall(call))
            return Task.FromResult(SkillTools.ExecuteLoadSkill(call, _skills));
        return _inner.ExecuteAsync(call, cancellationToken);
    }
}
