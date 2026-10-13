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
    public void Execute_OversizedFile_ReportsSkipNoticeInsteadOfSilentSkip()
    {
        // 回归（问题 A）：超过 1 MiB 的文件过去被静默跳过，输出"（未找到匹配）"，模型无法区分
        // "没有匹配"与"文件太大没搜"。修复后必须如实上报跳过数量与文件名样本。
        Write("big.dat", new string('x', (int)GrepTool.MaxFileBytes + 1) + "hit\n");
        var result = NewTool().ExecuteAsync("""{"pattern":"hit"}""").GetAwaiter().GetResult();

        Assert.Contains("1 个文件超过 1 MiB 已跳过", result);
        Assert.Contains("big.dat", result);
        Assert.Contains("read_file 分段读取", result);   // 给出可执行续查提示
        Assert.DoesNotContain("未找到匹配", result);       // 不再伪装成"无匹配"
    }

    [Fact]
    public void Execute_MultipleOversizedFiles_ReportTotalCount()
    {
        var big = new string('x', (int)GrepTool.MaxFileBytes + 1) + "hit\n";
        Write("a.dat", big);
        Write("b.dat", big);
        Write("c.dat", big);
        Write("d.dat", big);
        var result = NewTool().ExecuteAsync("""{"pattern":"hit"}""").GetAwaiter().GetResult();

        Assert.Contains("4 个文件超过 1 MiB 已跳过", result);   // 总数单列
        // 文件名只采样前 3 个。
        Assert.Contains("a.dat", result);
        Assert.DoesNotContain("d.dat", result);
    }

    [Fact]
    public void Execute_ResultCap_LimitsMatches()
    {
        // 单文件 120 行都命中 → 只返回前 MaxResults 条（默认 limit）。
        // 注意：JSON 里正则的反斜杠必须写成 \\（\d 不是合法 JSON 转义）。
        var content = string.Join('\n', Enumerable.Range(0, GrepTool.MaxResults + 20).Select(i => $"line {i}"));
        Write("a.txt", content);
        var result = NewTool().ExecuteAsync("""{"pattern":"line \\d+$"}""").GetAwaiter().GetResult();

        var matchLines = result.Split('\n', StringSplitOptions.RemoveEmptyEntries).Where(l => l.StartsWith("a.txt:")).ToArray();
        Assert.Equal(GrepTool.MaxResults, matchLines.Length);
        Assert.Contains("100 条匹配上限", result);   // 达上限 → 给出用 limit 续查的提示
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

    // ---- 悲观：EOF/空文件/编码/路径边界 ----

    [Fact]
    public void Execute_PathIsFile_ReturnsError()
    {
        Write("file.txt", "hit\n");
        var result = NewTool().ExecuteAsync("""{"pattern":"hit","path":"file.txt"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.Contains("文件", result);   // 明确提示"是文件而非目录"
    }

    [Fact]
    public void Execute_MatchAtEofWithoutTrailingNewline_IsReported()
    {
        Write("a.txt", "hit");
        var result = NewTool().ExecuteAsync("""{"pattern":"hit"}""").GetAwaiter().GetResult();

        Assert.Contains("a.txt:1: hit", result);
    }

    [Fact]
    public void Execute_EmptyFile_ReturnsNotFound()
    {
        Write("a.txt", "");
        var result = NewTool().ExecuteAsync("""{"pattern":"."}""").GetAwaiter().GetResult();

        Assert.Contains("未找到", result);
    }

    [Fact]
    public void Execute_UnicodePattern_MatchesUnicodeContent()
    {
        Write("a.txt", "包含中文内容\nplain");
        var result = NewTool().ExecuteAsync("""{"pattern":"中文"}""").GetAwaiter().GetResult();

        Assert.Contains("a.txt:1: 包含中文内容", result);
    }

    [Fact]
    public void Execute_CrlfFile_ContentHasNoCarriageReturn()
    {
        Write("a.txt", "one\r\nTODO\r\ntwo");
        var result = NewTool().ExecuteAsync("""{"pattern":"TODO"}""").GetAwaiter().GetResult();

        Assert.Contains("a.txt:2: TODO", result);
        Assert.DoesNotContain("\r", result.Split('\n')[0]);
    }

    [Fact]
    public void Execute_LongMatchLine_IsTruncatedWithNotice()
    {
        // 匹配行超过 MaxMatchLineChars → 截断并提示用 read_file 看完整行。
        Write("a.txt", new string('x', 5000) + "needle");
        var result = NewTool().ExecuteAsync("""{"pattern":"needle"}""").GetAwaiter().GetResult();

        var line = result.Split('\n', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        Assert.NotNull(line);
        Assert.StartsWith("a.txt:1: ", line);
        Assert.Contains("[truncated]", line);
        Assert.Contains("已截断", result);
        Assert.Contains("read_file", result);
    }

    // ---- 高级搜索选项（对应 pi grep 的 ignoreCase/literal/context/limit）----

    [Fact]
    public void Execute_IgnoreCaseOption_MatchesCaseInsensitively()
    {
        Write("a.txt", "TODO\ntodo\n");
        var result = NewTool().ExecuteAsync("""{"pattern":"todo","ignore_case":true}""").GetAwaiter().GetResult();

        var lines = result.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Contains("a.txt:1: TODO", lines);
        Assert.Contains("a.txt:2: todo", lines);
    }

    [Fact]
    public void Execute_LiteralOption_TreatsPatternAsLiteralText()
    {
        Write("a.txt", "a.b\naxb\n");
        var result = NewTool().ExecuteAsync("""{"pattern":"a.b","literal":true}""").GetAwaiter().GetResult();

        Assert.Contains("a.txt:1: a.b", result);
        Assert.DoesNotContain("axb", result);   // literal 模式下 . 不再匹配任意字符
    }

    [Fact]
    public void Execute_ContextOption_IncludesSurroundingLines()
    {
        Write("a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven");
        var result = NewTool().ExecuteAsync("""{"pattern":"four","context":2}""").GetAwaiter().GetResult();

        Assert.Contains("a.txt:4: four", result);   // 匹配行
        Assert.Contains("a.txt-2- two", result);    // 上下文行（- 分隔）
        Assert.Contains("a.txt-3- three", result);
        Assert.Contains("a.txt-5- five", result);
        Assert.Contains("a.txt-6- six", result);
    }

    [Fact]
    public void Execute_LimitOption_StopsEarlyWithNotice()
    {
        Write("a.txt", string.Join('\n', Enumerable.Range(0, 10).Select(i => $"hit {i}")));
        var result = NewTool().ExecuteAsync("""{"pattern":"hit","limit":3}""").GetAwaiter().GetResult();

        var matchLines = result.Split('\n', StringSplitOptions.RemoveEmptyEntries).Where(l => l.StartsWith("a.txt:")).ToArray();
        Assert.Equal(3, matchLines.Length);
        Assert.Contains("3 条匹配上限", result);
        Assert.Contains("limit=6", result);   // 提示用 2 倍 limit 续查
    }

    [Fact]
    public void Execute_AnchoredPattern_MatchesFullLine()
    {
        Write("a.txt", "abc\nxabc\n");
        var result = NewTool().ExecuteAsync("""{"pattern":"^abc$"}""").GetAwaiter().GetResult();

        Assert.Contains("a.txt:1: abc", result);
        Assert.DoesNotContain("a.txt:2", result);
    }

    [Fact]
    public void Execute_AlternationPattern_MatchesAnyBranch()
    {
        Write("a.txt", "alpha\nbeta\ngamma");
        var result = NewTool().ExecuteAsync("""{"pattern":"alpha|gamma"}""").GetAwaiter().GetResult();

        var lines = result.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Contains("a.txt:1: alpha", lines);
        Assert.Contains("a.txt:3: gamma", lines);
        Assert.DoesNotContain("beta", result);
    }
}
