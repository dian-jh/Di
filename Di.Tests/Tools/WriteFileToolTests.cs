using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 针对 <see cref="WriteFileTool"/> 的单元测试。
/// 覆盖：新建、覆盖、自动建父目录、目标为目录、参数缺失、空内容、路径解析、坏 JSON。
/// </summary>
public sealed class WriteFileToolTests : IDisposable
{
    private readonly string _base = Directory.CreateTempSubdirectory("di-write-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_base, recursive: true); } catch { }
    }

    private WriteFileTool NewTool() => new(_base);

    [Fact]
    public void Execute_CreatesNewFile_ContentRoundTrips()
    {
        var result = NewTool().ExecuteAsync("""{"path":"hello.txt","content":"hello world"}""").GetAwaiter().GetResult();

        Assert.StartsWith("OK", result);
        Assert.Equal("hello world", File.ReadAllText(Path.Combine(_base, "hello.txt")));
    }

    [Fact]
    public void Execute_OverwritesExistingFile()
    {
        File.WriteAllText(Path.Combine(_base, "a.txt"), "old");
        var result = NewTool().ExecuteAsync("""{"path":"a.txt","content":"new content"}""").GetAwaiter().GetResult();

        Assert.StartsWith("OK", result);
        Assert.Equal("new content", File.ReadAllText(Path.Combine(_base, "a.txt")));
    }

    [Fact]
    public void Execute_DeepNestedPath_CreatesParentDirectories()
    {
        var result = NewTool().ExecuteAsync("""{"path":"a/b/c/d.txt","content":"x"}""").GetAwaiter().GetResult();

        Assert.StartsWith("OK", result);
        Assert.True(File.Exists(Path.Combine(_base, "a", "b", "c", "d.txt")));
    }

    [Fact]
    public void Execute_EmptyContent_CreatesEmptyFile()
    {
        var result = NewTool().ExecuteAsync("""{"path":"empty.txt","content":""}""").GetAwaiter().GetResult();

        Assert.StartsWith("OK", result);
        Assert.Equal(string.Empty, File.ReadAllText(Path.Combine(_base, "empty.txt")));
    }

    [Fact]
    public void Execute_MultilineContent_PreservedExactly()
    {
        const string content = "line1\nline2\nline3";
        NewTool().ExecuteAsync($$"""{"path":"m.txt","content":{{JsonQuote(content)}}}""").GetAwaiter().GetResult();

        Assert.Equal(content, File.ReadAllText(Path.Combine(_base, "m.txt")));
    }

    [Fact]
    public void Execute_PathIsExistingDirectory_ReturnsError()
    {
        Directory.CreateDirectory(Path.Combine(_base, "adir"));
        var result = NewTool().ExecuteAsync("""{"path":"adir","content":"x"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.True(Directory.Exists(Path.Combine(_base, "adir")));   // 目录未被破坏
    }

    [Fact]
    public void Execute_MissingPathArgument_ReturnsError()
    {
        var result = NewTool().ExecuteAsync("""{"content":"x"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.Contains("path", result);
    }

    [Fact]
    public void Execute_MissingContentArgument_ReturnsError()
    {
        var result = NewTool().ExecuteAsync("""{"path":"a.txt"}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
        Assert.Contains("content", result);
    }

    [Fact]
    public void Execute_ContentNotString_ReturnsError()
    {
        var result = NewTool().ExecuteAsync("""{"path":"a.txt","content":42}""").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public void Execute_InvalidJson_ReturnsError()
    {
        var result = NewTool().ExecuteAsync("not json").GetAwaiter().GetResult();

        Assert.StartsWith("error:", result);
    }

    [Fact]
    public void Execute_RelativePathWithBackslashes_ResolvesAgainstBase()
    {
        var result = NewTool().ExecuteAsync("""{"path":"sub\\file.txt","content":"x"}""").GetAwaiter().GetResult();

        Assert.StartsWith("OK", result);
        Assert.True(File.Exists(Path.Combine(_base, "sub", "file.txt")));
    }

    [Fact]
    public void Execute_ReturnsConfirmationMentioningPath()
    {
        var result = NewTool().ExecuteAsync("""{"path":"out.txt","content":"data"}""").GetAwaiter().GetResult();

        Assert.Contains("out.txt", result);
        Assert.Contains("4", result);   // content.Length
    }

    [Fact]
    public void Execute_Definition_HasNameAndSchema()
    {
        var def = NewTool().Definition;
        Assert.Equal("write_file", def.Name);
        Assert.True(def.Parameters["properties"]!["content"] is not null);
        Assert.True(def.Parameters["properties"]!["path"] is not null);
    }

    private static string JsonQuote(string s) => System.Text.Json.JsonSerializer.Serialize(s);
}
