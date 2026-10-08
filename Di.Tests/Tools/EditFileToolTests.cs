using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 针对 <see cref="EditFileTool"/> 的单元测试。
/// 核心语义（第五章）：old_string 必须存在且唯一才成功，否则失败——不存在模糊替换。
/// 覆盖：唯一替换、歧义报错、未找到、文件不存在、空 old_string、多行、内容保持、参数/JSON 错误。
/// </summary>
public sealed class EditFileToolTests : IDisposable
{
    private readonly string _base = Directory.CreateTempSubdirectory("di-edit-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_base, recursive: true); } catch { }
    }

    private EditFileTool NewTool() => new(_base);

    private string Write(string name, string content)
    {
        var path = Path.Combine(_base, name);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        return path;
    }

    private static string Args(string path, string oldStr, string newStr)
        => $$"""{"path":{{JsonQuote(path)}},"old_string":{{JsonQuote(oldStr)}},"new_string":{{JsonQuote(newStr)}}}""";

    [Fact]
    public void Execute_UniqueMatch_ReplacesIt()
    {
        Write("a.txt", "hello world");
        var result = NewTool().ExecuteAsync(Args("a.txt", "world", "there")).GetAwaiter().GetResult();

        Assert.StartsWith("OK", result);
        Assert.Equal("hello there", File.ReadAllText(Path.Combine(_base, "a.txt")));
    }

    [Fact]
    public void Execute_MultipleOccurrences_ReturnsAmbiguityError_WithoutChangingFile()
    {
        Write("a.txt", "x y x y");
        var result = NewTool().ExecuteAsync(Args("a.txt", "y", "z")).GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.Contains("多次", result);                 // 明确提示歧义
        Assert.Equal("x y x y", File.ReadAllText(Path.Combine(_base, "a.txt")));   // 文件未被改动
    }

    [Fact]
    public void Execute_NotFound_ReturnsError_WithoutChangingFile()
    {
        Write("a.txt", "hello");
        var result = NewTool().ExecuteAsync(Args("a.txt", "missing", "x")).GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.Contains("未找到", result);
        Assert.Equal("hello", File.ReadAllText(Path.Combine(_base, "a.txt")));
    }

    [Fact]
    public void Execute_NonExistentFile_ReturnsError()
    {
        var result = NewTool().ExecuteAsync(Args("missing.txt", "a", "b")).GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public void Execute_EmptyOldString_ReturnsError()
    {
        Write("a.txt", "hello");
        var result = NewTool().ExecuteAsync(Args("a.txt", "", "x")).GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.Contains("old_string", result);
    }

    [Fact]
    public void Execute_OldStringEqualsNewString_IsNoOp()
    {
        Write("a.txt", "hello world");
        var result = NewTool().ExecuteAsync(Args("a.txt", "world", "world")).GetAwaiter().GetResult();

        Assert.StartsWith("OK", result);
        Assert.Equal("hello world", File.ReadAllText(Path.Combine(_base, "a.txt")));
    }

    [Fact]
    public void Execute_MultilineOldString_ReplacesAcrossLines()
    {
        Write("a.txt", "one\ntwo\nthree");
        var result = NewTool().ExecuteAsync(Args("a.txt", "one\ntwo", "1\n2")).GetAwaiter().GetResult();

        Assert.StartsWith("OK", result);
        Assert.Equal("1\n2\nthree", File.ReadAllText(Path.Combine(_base, "a.txt")));
    }

    [Fact]
    public void Execute_SurroundingContent_IsPreserved()
    {
        Write("a.txt", "start [to-replace] end");
        NewTool().ExecuteAsync(Args("a.txt", "[to-replace]", "[new]")).GetAwaiter().GetResult();

        Assert.Equal("start [new] end", File.ReadAllText(Path.Combine(_base, "a.txt")));
    }

    [Fact]
    public void Execute_NewStringLonger_ExpandsFile()
    {
        Write("a.txt", "ab");
        var result = NewTool().ExecuteAsync(Args("a.txt", "b", "bbbbbb")).GetAwaiter().GetResult();

        Assert.StartsWith("OK", result);
        Assert.Equal("abbbbbb", File.ReadAllText(Path.Combine(_base, "a.txt")));
    }

    [Fact]
    public void Execute_UniqueMatchAfterReadingWithLineNumbers_Works()
    {
        // 常见 Agent 流程：read_file 看到行号 → 用原文内容做 old_string。
        Write("a.txt", "def foo():\n    pass\n");
        var result = NewTool().ExecuteAsync(Args("a.txt", "def foo():", "def foo():\n    # added")).GetAwaiter().GetResult();

        Assert.StartsWith("OK", result);
        Assert.Contains("# added", File.ReadAllText(Path.Combine(_base, "a.txt")));
    }

    [Fact]
    public void Execute_ReturnMentionsLineCounts()
    {
        Write("a.txt", "a\nb\nc");
        var result = NewTool().ExecuteAsync(Args("a.txt", "b", "x\ny\nz")).GetAwaiter().GetResult();

        Assert.StartsWith("OK", result);
        Assert.Contains("1 行 → 3 行", result);
    }

    [Fact]
    public void Execute_MissingPathArgument_ReturnsError()
    {
        var result = NewTool().ExecuteAsync("""{"old_string":"a","new_string":"b"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public void Execute_MissingNewStringArgument_ReturnsError()
    {
        Write("a.txt", "a");
        var result = NewTool().ExecuteAsync("""{"path":"a.txt","old_string":"a"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.Contains("new_string", result);
    }

    [Fact]
    public void Execute_InvalidJson_ReturnsError()
    {
        var result = NewTool().ExecuteAsync("{bad").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public void Execute_Definition_HasEditFileSchema()
    {
        var def = NewTool().Definition;
        Assert.Equal("edit_file", def.Name);
        Assert.True(def.Parameters["properties"]!["old_string"] is not null);
        Assert.True(def.Parameters["properties"]!["new_string"] is not null);
    }

    private static string JsonQuote(string s) => System.Text.Json.JsonSerializer.Serialize(s);
}
