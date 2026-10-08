using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 针对 <see cref="GlobTool"/> 的单元测试。
/// 覆盖：递归匹配、根目录命中、* 不跨目录、子目录起点、无匹配、上限、参数/路径错误、只匹配文件。
/// </summary>
public sealed class GlobToolTests : IDisposable
{
    private readonly string _base = Directory.CreateTempSubdirectory("di-glob-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_base, recursive: true); } catch { }
    }

    private GlobTool NewTool() => new(_base);

    private void Write(string relative, string content = "")
    {
        var path = Path.Combine(_base, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
    }

    [Fact]
    public void Execute_DoubleStarCs_FindsAllRecursively_AndRoot()
    {
        Write("a.cs");
        Write("src/b.cs");
        Write("src/deep/c.cs");
        Write("src/deep/d.txt");

        var result = NewTool().ExecuteAsync("""{"pattern":"**/*.cs"}""").GetAwaiter().GetResult();

        var lines = result.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Contains("a.cs", lines);
        Assert.Contains("src/b.cs", lines);
        Assert.Contains("src/deep/c.cs", lines);
        Assert.DoesNotContain(lines, l => l.EndsWith(".txt", StringComparison.Ordinal));
    }

    [Fact]
    public void Execute_SingleStar_OnlyMatchesRootLevel()
    {
        Write("a.cs");
        Write("src/b.cs");

        var result = NewTool().ExecuteAsync("""{"pattern":"*.cs"}""").GetAwaiter().GetResult();

        Assert.Equal("a.cs", result);
    }

    [Fact]
    public void Execute_PathParameter_SearchStartAtSubdirectory()
    {
        Write("src/b.cs");
        Write("src/deep/c.cs");
        Write("other/d.cs");

        var result = NewTool().ExecuteAsync("""{"pattern":"**/*.cs","path":"src"}""").GetAwaiter().GetResult();

        // 相对 searchRoot 返回，不含 "src/" 前缀。
        Assert.DoesNotContain("other", result);
        Assert.Contains("b.cs", result);
        Assert.Contains("deep/c.cs", result);
    }

    [Fact]
    public void Execute_NoMatch_ReturnsNotFoundMarker()
    {
        Write("a.cs");
        var result = NewTool().ExecuteAsync("""{"pattern":"**/*.py"}""").GetAwaiter().GetResult();

        Assert.Contains("未找到", result);
    }

    [Fact]
    public void Execute_ConcreteSubtreePattern_Works()
    {
        Write("src/components/Button.tsx");
        Write("src/components/ui/Button.tsx");
        Write("src/other/Button.tsx");

        var result = NewTool().ExecuteAsync("""{"pattern":"src/components/**/Button.tsx"}""").GetAwaiter().GetResult();

        var lines = result.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Contains("src/components/Button.tsx", lines);
        Assert.Contains("src/components/ui/Button.tsx", lines);
        Assert.DoesNotContain("src/other", result);
    }

    [Fact]
    public void Execute_DirectoriesAreNotReturned()
    {
        Write("a/f1.txt");
        Write("a/f2.txt");

        var result = NewTool().ExecuteAsync("""{"pattern":"**"}""").GetAwaiter().GetResult();

        var lines = result.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Contains("a/f1.txt", lines);
        Assert.Contains("a/f2.txt", lines);
        Assert.DoesNotContain("a", lines);   // 目录本身不作为结果
    }

    [Fact]
    public void Execute_ResultsAreRelativeToSearchRoot()
    {
        Write("x/deep/file.json");
        var result = NewTool().ExecuteAsync("""{"pattern":"**/*.json"}""").GetAwaiter().GetResult();

        Assert.Contains("x/deep/file.json", result);
        Assert.DoesNotContain(_base, result);   // 不含绝对路径
    }

    [Fact]
    public void Execute_MissingPattern_ReturnsError()
    {
        var result = NewTool().ExecuteAsync("""{}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.Contains("pattern", result);
    }

    [Fact]
    public void Execute_NonexistentPath_ReturnsError()
    {
        var result = NewTool().ExecuteAsync("""{"pattern":"**","path":"nope"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public void Execute_InvalidJson_ReturnsError()
    {
        var result = NewTool().ExecuteAsync("nope").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public void Execute_ResultCap_ReturnsAtMostMaxResults()
    {
        // 创建超过上限的文件，验证结果数被截断（且不崩溃）。
        for (var i = 0; i < GlobTool.MaxResults + 5; i++)
            Write($"f{i}.txt");

        var result = NewTool().ExecuteAsync("""{"pattern":"**/*.txt"}""").GetAwaiter().GetResult();

        Assert.Equal(GlobTool.MaxResults, result.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length);
    }

    [Fact]
    public void Execute_OnWindows_MatchingIsCaseInsensitive()
    {
        if (!OperatingSystem.IsWindows())
            return;   // Linux 文件系统区分大小写，跳过

        Write("READMe.md");
        var result = NewTool().ExecuteAsync("""{"pattern":"**/readme.md"}""").GetAwaiter().GetResult();

        Assert.Contains("READMe.md", result);
    }

    [Fact]
    public void Execute_Definition_HasNameAndPatternSchema()
    {
        var def = NewTool().Definition;
        Assert.Equal("glob", def.Name);
        Assert.True(def.Parameters["properties"]!["pattern"] is not null);
    }
}
