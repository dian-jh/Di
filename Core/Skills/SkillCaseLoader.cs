using System.Text.Json;

namespace Core.Skills;

/// <summary>
/// 从 JSON 用例文件加载带标签的匹配用例（触发 / 排除测试），供 <see cref="SkillEvaluator"/> 评估。
/// 格式：JSON 数组，每项 <c>{"message": "...", "expected_skills": ["..."]}</c>（snake_case，与线格式一致）。
/// <c>message</c> 必填非空；<c>expected_skills</c> 可选（缺省 = 排除测试，期望不命中任何 skill）。
/// 容错：文件级错误（不存在 / 非法 JSON / 根不是数组）抛异常；条目级错误告警并跳过（回调 warn）。
/// </summary>
public static class SkillCaseLoader
{
    public static IReadOnlyList<SkillTestCase> Load(string path, Action<string>? warn = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);

        using var doc = JsonDocument.Parse(File.ReadAllText(path));   // 文件不存在 / 非法 JSON 在此抛出
        if (doc.RootElement.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException($"用例文件必须是 JSON 数组（{path}）");

        var cases = new List<SkillTestCase>();
        var index = 0;
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            index++;
            if (item.ValueKind != JsonValueKind.Object)
            {
                warn?.Invoke($"第 {index} 项不是对象，跳过");
                continue;
            }
            if (!item.TryGetProperty("message", out var message) ||
                message.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(message.GetString()))
            {
                warn?.Invoke($"第 {index} 项缺少非空 message，跳过");
                continue;
            }

            var expected = new List<string>();
            if (item.TryGetProperty("expected_skills", out var expectedSkills))
            {
                if (expectedSkills.ValueKind != JsonValueKind.Array)
                {
                    warn?.Invoke($"第 {index} 项 expected_skills 不是数组，跳过");
                    continue;
                }
                var valid = true;
                foreach (var name in expectedSkills.EnumerateArray())
                {
                    if (name.ValueKind != JsonValueKind.String)
                    {
                        valid = false;
                        break;
                    }
                }
                if (!valid)
                {
                    warn?.Invoke($"第 {index} 项 expected_skills 含非字符串项，跳过");
                    continue;
                }
                foreach (var name in expectedSkills.EnumerateArray())
                    expected.Add(name.GetString()!);
            }

            cases.Add(new SkillTestCase(message.GetString()!, expected));
        }

        return cases;
    }
}
