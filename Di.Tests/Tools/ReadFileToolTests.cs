using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 针对 <see cref="ReadFileTool"/> 的单元测试。
/// 覆盖：正常读取、行号、范围读取、各种失败（不存在/目录/过大/参数错误/坏 JSON）、路径解析。
/// </summary>
public sealed class ReadFileToolTests : IDisposable
{
    private readonly string _base = Directory.CreateTempSubdirectory("di-read-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_base, recursive: true); } catch { /* 清理失败不影响测试结论 */ }
    }

    private ReadFileTool NewTool() => new(_base);

    private string Write(string name, string content)
    {
        var path = Path.Combine(_base, name);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        return path;
    }

    // ---- 正常路径 ----

    [Fact]
    public void Execute_ExistingFile_ReturnsContentWithLineNumbers()
    {
        Write("a.txt", "first\nsecond\nthird");
        var result = NewTool().ExecuteAsync("""{"path":"a.txt"}""").GetAwaiter().GetResult();

        Assert.Equal("1: first\n2: second\n3: third", result);
    }

    [Fact]
    public void Execute_FileWithoutTrailingNewline_LastLineIncluded()
    {
        Write("a.txt", "one\ntwo");
        var result = NewTool().ExecuteAsync("""{"path":"a.txt"}""").GetAwaiter().GetResult();

        Assert.Equal("1: one\n2: two", result);
    }

    [Fact]
    public void Execute_EmptyFile_ReturnsEmptyString()
    {
        Write("a.txt", "");
        var result = NewTool().ExecuteAsync("""{"path":"a.txt"}""").GetAwaiter().GetResult();

        Assert.Equal(string.Empty, result);
    }

    [Fact]
    public void Execute_CrlfFile_LinesSplitCorrectly()
    {
        Write("a.txt", "line1\r\nline2\r\n");
        var result = NewTool().ExecuteAsync("""{"path":"a.txt"}""").GetAwaiter().GetResult();

        Assert.Equal("1: line1\n2: line2", result);
    }

    [Fact]
    public void Execute_SubdirectoryPath_ResolvesRelativeToBase()
    {
        Write(Path.Combine("src", "a.cs"), "code");
        var result = NewTool().ExecuteAsync("""{"path":"src/a.cs"}""").GetAwaiter().GetResult();

        Assert.Equal("1: code", result);
    }

    // ---- 行范围 ----

    [Fact]
    public void Execute_StartLineAndEndLine_ReturnsThatSlice()
    {
        Write("a.txt", "1\n2\n3\n4\n5");
        var result = NewTool().ExecuteAsync("""{"path":"a.txt","start_line":2,"end_line":4}""").GetAwaiter().GetResult();

        Assert.Equal("2: 2\n3: 3\n4: 4", result);
    }

    [Fact]
    public void Execute_StartLineOnly_ReadsToEnd()
    {
        Write("a.txt", "1\n2\n3");
        var result = NewTool().ExecuteAsync("""{"path":"a.txt","start_line":2}""").GetAwaiter().GetResult();

        Assert.Equal("2: 2\n3: 3", result);
    }

    [Fact]
    public void Execute_EndLineBeyondFileLength_ClampsToEof()
    {
        Write("a.txt", "1\n2");
        var result = NewTool().ExecuteAsync("""{"path":"a.txt","start_line":1,"end_line":999}""").GetAwaiter().GetResult();

        Assert.Equal("1: 1\n2: 2", result);
    }

    [Fact]
    public void Execute_StartLineAboveLineCount_ReturnsError()
    {
        Write("a.txt", "1\n2");
        var result = NewTool().ExecuteAsync("""{"path":"a.txt","start_line":5}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public void Execute_EndLineBelowStartLine_ReturnsError()
    {
        Write("a.txt", "1\n2\n3");
        var result = NewTool().ExecuteAsync("""{"path":"a.txt","start_line":3,"end_line":1}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public void Execute_StartLineBelowOne_ReturnsError()
    {
        Write("a.txt", "1\n2");
        var result = NewTool().ExecuteAsync("""{"path":"a.txt","start_line":0}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    // ---- 失败路径 ----

    [Fact]
    public void Execute_NonExistentFile_ReturnsError()
    {
        var result = NewTool().ExecuteAsync("""{"path":"missing.txt"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.Contains("不存在", result);
    }

    [Fact]
    public void Execute_PathIsDirectory_ReturnsError()
    {
        Directory.CreateDirectory(Path.Combine(_base, "adir"));
        var result = NewTool().ExecuteAsync("""{"path":"adir"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public void Execute_MissingPathArgument_ReturnsError()
    {
        var result = NewTool().ExecuteAsync("""{}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.Contains("path", result);
    }

    [Fact]
    public void Execute_PathNotString_ReturnsError()
    {
        var result = NewTool().ExecuteAsync("""{"path":123}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public void Execute_StartLineNotInteger_ReturnsError()
    {
        Write("a.txt", "x");
        var result = NewTool().ExecuteAsync("""{"path":"a.txt","start_line":"2"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.Contains("start_line", result);
    }

    [Fact]
    public void Execute_InvalidJson_ReturnsError()
    {
        var result = NewTool().ExecuteAsync("{not json").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public void Execute_OversizedFile_ReturnsError()
    {
        // 超过 MaxBytes(1MiB) 的文件拒绝读取，防止把巨型文件灌进上下文。
        var path = Write("big.bin", new string('x', (int)ReadFileTool.MaxBytes + 1));
        var result = NewTool().ExecuteAsync($$"""{"path":"{{Path.GetFileName(path)}}"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.Contains("过大", result);
    }

    [Fact]
    public void Execute_Definition_HasNameReadFileAndPathSchema()
    {
        var def = NewTool().Definition;
        Assert.Equal("read_file", def.Name);
        Assert.Equal("object", def.Parameters["type"]!.GetValue<string>());
        Assert.True(def.Parameters["properties"]!["path"] is not null);
    }

    // ---- 悲观：锁文件/非法路径/边界 ----

    [Fact]
    public void Execute_LockedFile_ReturnsErrorInsteadOfThrowing()
    {
        if (!OperatingSystem.IsWindows())
            return;   // Unix 不强制 FileShare.None，锁不住

        var path = Path.Combine(_base, "locked.txt");
        using (var fs = new FileStream(path, FileMode.Create, FileAccess.ReadWrite, FileShare.None))
        {
            fs.SetLength(100);
            var result = NewTool().ExecuteAsync("""{"path":"locked.txt"}""").GetAwaiter().GetResult();

            Assert.StartsWith("error:", result);   // 读被占用文件 → error 观察，而非异常冒泡
        }
    }

    [Fact]
    public void Execute_PathWithNulChar_ReturnsErrorInsteadOfThrowing()
    {
        var result = NewTool().ExecuteAsync("""{"path":"bad\u0000dir.txt"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);   // Path.GetFullPath 对 NUL 抛 ArgumentException → 应转为 error
    }

    [Fact]
    public void Execute_UnicodeContent_LineNumbersAreCorrect()
    {
        Write("c.txt", "第一行\n第二行\nthird");
        var result = NewTool().ExecuteAsync("""{"path":"c.txt"}""").GetAwaiter().GetResult();

        Assert.Equal("1: 第一行\n2: 第二行\n3: third", result);
    }

    [Fact]
    public void Execute_FileExactlyAtMaxBytes_IsReadable()
    {
        Write("at.txt", new string('x', (int)ReadFileTool.MaxBytes));
        var result = NewTool().ExecuteAsync("""{"path":"at.txt"}""").GetAwaiter().GetResult();

        Assert.StartsWith("1: ", result);   // 恰在上限 → 正常读取，不是 error
    }

    [Fact]
    public void Execute_BlankLines_PreservedWithNumbers()
    {
        Write("b.txt", "a\n\nb");
        var result = NewTool().ExecuteAsync("""{"path":"b.txt"}""").GetAwaiter().GetResult();

        Assert.Equal("1: a\n2: \n3: b", result);
    }

    [Fact]
    public void Execute_LongSingleLine_ReturnedInFull()
    {
        Write("long.txt", "x" + new string('y', 5000));
        var result = NewTool().ExecuteAsync("""{"path":"long.txt"}""").GetAwaiter().GetResult();

        Assert.StartsWith("1: x", result);
        Assert.Contains(new string('y', 5000), result);   // 读文件不做截断，整行返回
    }

    [Fact]
    public void Execute_FileWithOnlyNewline_ReportsOneBlankLine()
    {
        Write("nl.txt", "\n");
        var result = NewTool().ExecuteAsync("""{"path":"nl.txt"}""").GetAwaiter().GetResult();

        Assert.Equal("1: ", result);
    }
}
