using System.Text.Json;
using Core.Skills;

namespace Di.Tests.Skills;

/// <summary>
/// <see cref="SkillCaseLoader"/> 的单元测试：JSON 用例文件 → 带标签匹配用例（触发 / 排除测试）。
/// 文件级错误抛异常；条目级错误告警并跳过（与 SkillRepository 的容错哲学一致）。
/// </summary>
public sealed class SkillCaseLoaderTests
{
    [Fact]
    public void Load_ValidFile_ParsesCases()
    {
        var path = WriteCases("""
            [
              { "message": "跑一下后端测试", "expected_skills": ["backend-tests"] },
              { "message": "随便聊聊", "expected_skills": [] }
            ]
            """);

        var cases = SkillCaseLoader.Load(path);

        Assert.Equal(2, cases.Count);
        Assert.Equal("跑一下后端测试", cases[0].Message);
        Assert.Equal(["backend-tests"], cases[0].ExpectedSkills);
        Assert.Equal("随便聊聊", cases[1].Message);
        Assert.Empty(cases[1].ExpectedSkills);
    }

    [Fact]
    public void Load_MissingExpectedSkills_DefaultsToExclusionCase()
    {
        var path = WriteCases("""[ { "message": "帮我部署上线" } ]""");

        var cases = SkillCaseLoader.Load(path);

        Assert.Single(cases);
        Assert.Empty(cases[0].ExpectedSkills);
    }

    [Fact]
    public void Load_FileNotFound_Throws()
    {
        var missing = Path.Combine(Path.GetTempPath(), "di-no-cases-" + Guid.NewGuid().ToString("N") + ".json");

        Assert.ThrowsAny<IOException>(() => SkillCaseLoader.Load(missing));
    }

    [Fact]
    public void Load_InvalidJson_Throws()
    {
        var path = WriteCases("这不是 JSON");

        Assert.ThrowsAny<JsonException>(() => SkillCaseLoader.Load(path));   // JsonReaderException ⊆ JsonException
    }

    [Fact]
    public void Load_RootNotArray_Throws()
    {
        var path = WriteCases("""{ "message": "hi" }""");

        Assert.Throws<InvalidDataException>(() => SkillCaseLoader.Load(path));
    }

    [Fact]
    public void Load_MalformedEntry_WarnsAndSkips()
    {
        var path = WriteCases("""
            [
              { "message": "" },
              { "message": "跑一下后端测试", "expected_skills": ["backend-tests"] },
              { "expected_skills": ["x"] }
            ]
            """);
        var warnings = new List<string>();

        var cases = SkillCaseLoader.Load(path, warnings.Add);

        Assert.Single(cases);
        Assert.Equal(["backend-tests"], cases[0].ExpectedSkills);
        Assert.Equal(2, warnings.Count);
    }

    [Fact]
    public void Load_ExpectedSkillsNotArray_WarnsAndSkips()
    {
        var path = WriteCases("""[ { "message": "hi", "expected_skills": "backend-tests" } ]""");
        var warnings = new List<string>();

        var cases = SkillCaseLoader.Load(path, warnings.Add);

        Assert.Empty(cases);
        Assert.Single(warnings);
    }

    [Fact]
    public void Load_ExpectedSkillsContainsNonString_WarnsAndSkips()
    {
        var path = WriteCases("""[ { "message": "hi", "expected_skills": ["ok", 42] } ]""");
        var warnings = new List<string>();

        var cases = SkillCaseLoader.Load(path, warnings.Add);

        Assert.Empty(cases);
        Assert.Single(warnings);
    }

    private static string WriteCases(string content)
    {
        var path = Path.Combine(Path.GetTempPath(), "di-cases-" + Guid.NewGuid().ToString("N") + ".json");
        File.WriteAllText(path, content);
        return path;
    }
}
