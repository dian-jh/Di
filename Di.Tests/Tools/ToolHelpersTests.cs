using System.Text.Json;
using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 共享助手（<see cref="ToolHelpers"/>）的悲观测试：截断边界、路径解析、Schema、参数校验。
/// </summary>
public sealed class ToolHelpersTests : IDisposable
{
    private readonly string _base = Directory.CreateTempSubdirectory("di-helper-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_base, recursive: true); } catch { }
    }

    // ---- Truncate ----

    [Fact]
    public void Truncate_ShortText_IsUnchanged()
    {
        var text = new string('a', 100);
        Assert.Equal(text, ToolHelpers.Truncate(text));
    }

    [Fact]
    public void Truncate_ExactlyAtLimit_IsUnchanged()
    {
        var text = new string('a', 3000 + 1000);
        Assert.Equal(text, ToolHelpers.Truncate(text));   // 等于头+尾阈值 → 不截
    }

    [Fact]
    public void Truncate_Empty_ReturnsEmpty()
    {
        Assert.Equal(string.Empty, ToolHelpers.Truncate(string.Empty));
    }

    [Fact]
    public void Truncate_LongText_KeepsHeadAndTailWithMarker()
    {
        var text = new string('a', 3000) + new string('b', 500) + new string('c', 1000);
        var result = ToolHelpers.Truncate(text);

        Assert.StartsWith(new string('a', 3000), result);
        Assert.EndsWith(new string('c', 1000), result);
        Assert.Contains("已截断", result);
        Assert.DoesNotContain('b', result);   // 中间被删掉
    }

    // ---- ResolvePath ----

    [Fact]
    public void ResolvePath_ForwardSlashes_BecomePlatformSeparator()
    {
        var result = ToolHelpers.ResolvePath(_base, "a/b/c.txt");
        Assert.Equal(Path.Combine(_base, "a", "b", "c.txt"), result);
    }

    [Fact]
    public void ResolvePath_AbsolutePath_IsReturnedAsIs()
    {
        var abs = Path.Combine(_base, "x.txt");
        Assert.Equal(abs, ToolHelpers.ResolvePath(_base, abs));
    }

    [Fact]
    public void ResolvePath_ParentSegments_EscapeBaseByDesign()
    {
        // 说明性测试：路径穿越不受限（MVP 无沙盒约束层，见第五章安全章节）。
        var result = ToolHelpers.ResolvePath(_base, "../outside.txt");
        Assert.Equal(Path.GetFullPath(Path.Combine(_base, "..", "outside.txt")), result);
        Assert.False(result.StartsWith(_base, StringComparison.Ordinal));
    }

    [Fact]
    public void ResolvePath_Empty_ResolvesToBase()
    {
        Assert.Equal(Path.GetFullPath(_base), ToolHelpers.ResolvePath(_base, ""));
    }

    // ---- Schema ----

    [Fact]
    public void Schema_BuildsRequiredAndProperties()
    {
        var schema = ToolHelpers.Schema(("a", "string", "A 参数"), ("b", "integer", "B 参数"));

        Assert.Equal("object", schema["type"]!.GetValue<string>());
        var required = schema["required"]!.AsArray().Select(x => x!.GetValue<string>()).ToList();
        Assert.Equal(["a", "b"], required);
        Assert.Equal("string", schema["properties"]!["a"]!["type"]!.GetValue<string>());
        Assert.Equal("A 参数", schema["properties"]!["a"]!["description"]!.GetValue<string>());
    }

    // ---- 参数解析 ----

    [Fact]
    public void TryGetString_RejectsEmptyAndWhitespace()
    {
        using var doc = JsonDocument.Parse("""{"a":"","b":"   "}""");
        var root = doc.RootElement;

        Assert.False(ToolHelpers.TryGetString(root, "a", out _, out var err));
        Assert.Contains("a", err!);
        Assert.False(ToolHelpers.TryGetString(root, "b", out _, out _));
    }

    [Fact]
    public void TryGetContent_AllowsEmptyString()
    {
        using var doc = JsonDocument.Parse("""{"c":""}""");
        Assert.True(ToolHelpers.TryGetContent(doc.RootElement, "c", out var v, out _));
        Assert.Equal(string.Empty, v);
    }

    [Fact]
    public void TryGetOptionalInt_RejectsNonInteger()
    {
        using var doc = JsonDocument.Parse("""{"n":1.5}""");
        Assert.False(ToolHelpers.TryGetOptionalInt(doc.RootElement, "n", out _, out var err));
        Assert.Contains("n", err!);
    }

    [Fact]
    public void TryGetOptionalString_ReturnsNullForNonString()
    {
        using var doc = JsonDocument.Parse("""{"s":42}""");
        Assert.Null(ToolHelpers.TryGetOptionalString(doc.RootElement, "s"));
    }

    [Fact]
    public void EnumerateFiles_SkipsMissingRoot_Gracefully()
    {
        // 根目录不存在：不应抛异常，返回空序列。
        var missing = Path.Combine(_base, "does-not-exist");
        Assert.Empty(ToolHelpers.EnumerateFiles(missing).ToList());
    }

    [Fact]
    public void EnumerateFiles_SymlinkCycle_TerminatesWithoutInfiniteLoop()
    {
        // 链接目录指向祖先 → 朴素遍历会无限循环（Windows junction / Unix symlink）。
        // 必须跳过链接目录，只命中真实文件。无符号链接权限的环境跳过。
        Directory.CreateDirectory(Path.Combine(_base, "real"));
        File.WriteAllText(Path.Combine(_base, "real", "data.txt"), "x");
        try
        {
            Directory.CreateSymbolicLink(Path.Combine(_base, "loop"), _base);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or PlatformNotSupportedException)
        {
            return;   // 环境不支持创建符号链接
        }

        var files = ToolHelpers.EnumerateFiles(_base).ToList();

        Assert.Single(files);
        Assert.Contains(files, f => f.EndsWith("data.txt", StringComparison.Ordinal));
    }
}
