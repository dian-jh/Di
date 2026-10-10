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
    public void TryGetOptionalBool_AcceptsTrueFalseAndMissing()
    {
        using var doc = JsonDocument.Parse("""{"t":true,"f":false}""");
        var root = doc.RootElement;

        Assert.True(ToolHelpers.TryGetOptionalBool(root, "t", out var t, out _));
        Assert.True(t);
        Assert.True(ToolHelpers.TryGetOptionalBool(root, "f", out var f, out _));
        Assert.False(f);
        Assert.True(ToolHelpers.TryGetOptionalBool(root, "missing", out var m, out _));
        Assert.Null(m);
    }

    [Fact]
    public void TryGetOptionalBool_RejectsNonBoolean()
    {
        using var doc = JsonDocument.Parse("""{"b":"yes"}""");
        Assert.False(ToolHelpers.TryGetOptionalBool(doc.RootElement, "b", out _, out var err));
        Assert.Contains("b", err!);
    }

    [Fact]
    public void AddOptionalProperty_DoesNotAddToRequired()
    {
        var schema = ToolHelpers.Schema(("a", "string", "A 参数"));
        ToolHelpers.AddOptionalProperty(schema, "b", "integer", "B 参数");

        var required = schema["required"]!.AsArray().Select(x => x!.GetValue<string>()).ToList();
        Assert.Equal(["a"], required);
        Assert.Equal("integer", schema["properties"]!["b"]!["type"]!.GetValue<string>());
    }

    [Fact]
    public void EnumerateFiles_SkipsMissingRoot_Gracefully()
    {
        // 根目录不存在：不应抛异常，返回空序列。
        var missing = Path.Combine(_base, "does-not-exist");
        Assert.Empty(ToolHelpers.EnumerateFiles(missing).ToList());
    }

    [Fact]
    public void EnumerateFiles_SkipsBuildAndVcsDirectories()
    {
        Directory.CreateDirectory(Path.Combine(_base, "src"));
        File.WriteAllText(Path.Combine(_base, "src", "a.cs"), "x");
        Directory.CreateDirectory(Path.Combine(_base, "obj"));
        Directory.CreateDirectory(Path.Combine(_base, "node_modules"));
        Directory.CreateDirectory(Path.Combine(_base, ".git"));
        File.WriteAllText(Path.Combine(_base, "obj", "gen.cs"), "x");
        File.WriteAllText(Path.Combine(_base, "node_modules", "lib.js"), "x");
        File.WriteAllText(Path.Combine(_base, ".git", "config"), "x");

        var files = ToolHelpers.EnumerateFiles(_base).ToList();

        Assert.Single(files);   // 只命中 src/a.cs，obj/node_modules/.git 下的被跳过
        Assert.Contains(files, f => f.EndsWith("a.cs", StringComparison.Ordinal));
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
