using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 针对 <see cref="GrepTool"/> 的单元测试。
/// 返回格式（第五章示例）：src/api.py:42: # TODO: ... —— 相对路径:行号: 内容。
/// 覆盖：格式、多文件行号、正则、glob 过滤、path 范围、大小写敏感、坏正则、无匹配、二进制跳过、上限。
/// </summary>
public sealed class GrepToolTests : IDisposable
{
    private readonly string _base = Directory.CreateTempSubdirectory("di-grep-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_base, recursive: true); } catch { }
    }

    private GrepTool NewTool() => new(_base);

    private void Write(string relative, string content)
    {
        var path = Path.Combine(_base, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
    }

    [Fact]
    public void Execute_Matches_ReturnFilePathLineAndContent()
    {
        Write("a.txt", "alpha\nbeta\nalpha again");
        var result = NewTool().ExecuteAsync("""{"pattern":"alpha"}""").GetAwaiter().GetResult();

        var lines = result.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Contains("a.txt:1: alpha", lines);
        Assert.Contains("a.txt:3: alpha again", lines);
    }

    [Fact]
    public void Execute_MatchesAcrossFiles_LineNumbersArePerFile()
    {
        Write("a.txt", "x\nTODO\n");
        Write("b.txt", "TODO\nx\n");
        var result = NewTool().ExecuteAsync("""{"pattern":"TODO"}""").GetAwaiter().GetResult();

        var lines = result.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Contains("a.txt:2: TODO", lines);
        Assert.Contains("b.txt:1: TODO", lines);
    }

    [Fact]
    public void Execute_RegexPattern_SupportsComplexMatching()
    {
        Write("a.txt", "def handle_a():\n    pass\nclass Other:\n    pass");
        var result = NewTool().ExecuteAsync("""{"pattern":"def handle.*"}""").GetAwaiter().GetResult();

        Assert.Contains("a.txt:1: def handle_a():", result);
        Assert.DoesNotContain("class Other", result);
    }

    [Fact]
    public void Execute_GlobFilter_RestrictsFiles()
    {
        Write("src/a.py", "TODO\n");
        Write("src/b.txt", "TODO\n");
        var result = NewTool().ExecuteAsync("""{"pattern":"TODO","glob":"**/*.py"}""").GetAwaiter().GetResult();

        Assert.Contains("src/a.py", result);
        Assert.DoesNotContain("b.txt", result);
    }

    [Fact]
    public void Execute_PathParameter_ScopesSearch()
    {
        Write("src/a.py", "TODO\n");
        Write("tests/b.py", "TODO\n");
        var result = NewTool().ExecuteAsync("""{"pattern":"TODO","path":"src"}""").GetAwaiter().GetResult();

        Assert.Contains("a.py", result);
        Assert.DoesNotContain("tests", result);
    }

    [Fact]
    public void Execute_IsCaseSensitiveByDefault()
    {
        Write("a.txt", "TODO\ntodo\n");
        var result = NewTool().ExecuteAsync("""{"pattern":"TODO"}""").GetAwaiter().GetResult();

        var lines = result.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Contains("a.txt:1: TODO", lines);
        Assert.DoesNotContain("todo", result);   // 小写不匹配
    }

    [Fact]
    public void Execute_NoMatch_ReturnsNotFoundMarker()
    {
        Write("a.txt", "nothing here");
        var result = NewTool().ExecuteAsync("""{"pattern":"zzz"}""").GetAwaiter().GetResult();

        Assert.Contains("未找到", result);
    }

    [Fact]
    public void Execute_InvalidRegex_ReturnsError()
    {
        Write("a.txt", "x");
        var result = NewTool().ExecuteAsync("""{"pattern":"[unclosed"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.Contains("正则", result);
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
        var result = NewTool().ExecuteAsync("""{"pattern":"x","path":"nope"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public void Execute_BinaryFileWithNullBytes_IsSkipped()
    {
        // 含 NUL 的"文本"会在 ReadLines 中产生非预期行，测试不崩溃且能继续返回其它文件结果。
        var path = Path.Combine(_base, "bin.dat");
        File.WriteAllBytes(path, [0, 0, 0, 1]);
        Write("a.txt", "hit\n");

        var result = NewTool().ExecuteAsync("""{"pattern":"hit"}""").GetAwaiter().GetResult();

        Assert.Contains("a.txt:1: hit", result);
    }

    [Fact]
    public void Execute_OversizedFile_IsSkipped()
    {
        Write("big.dat", new string('x', (int)GrepTool.MaxFileBytes + 1) + "hit\n");
        Write("a.txt", "hit\n");
        var result = NewTool().ExecuteAsync("""{"pattern":"hit"}""").GetAwaiter().GetResult();

        Assert.Contains("a.txt:1: hit", result);   // 大文件被跳过，不阻塞小文件结果
    }

    [Fact]
    public void Execute_ResultCap_LimitsMatches()
    {
        // 单文件 120 行都命中 → 只返回前 MaxResults 条。
        // 注意：JSON 里正则的反斜杠必须写成 \\（\d 不是合法 JSON 转义）。
        var content = string.Join('\n', Enumerable.Range(0, GrepTool.MaxResults + 20).Select(i => $"line {i}"));
        Write("a.txt", content);
        var result = NewTool().ExecuteAsync("""{"pattern":"line \\d+$"}""").GetAwaiter().GetResult();

        Assert.Equal(GrepTool.MaxResults, result.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length);
    }

    [Fact]
    public void Execute_InvalidJson_ReturnsError()
    {
        var result = NewTool().ExecuteAsync("nope").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public void Execute_Definition_HasNameAndSchema()
    {
        var def = NewTool().Definition;
        Assert.Equal("grep", def.Name);
        Assert.True(def.Parameters["properties"]!["pattern"] is not null);
        Assert.True(def.Parameters["properties"]!["glob"] is not null);
    }
}
