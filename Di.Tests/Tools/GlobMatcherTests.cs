using Core.Tools;

namespace Di.Tests.Tools;

/// <summary>
/// 针对 <see cref="GlobMatcher"/>（glob → 正则）的纯逻辑测试。
/// 语义约定：* 匹配同一目录内任意段，? 匹配单字符，** 跨目录，**/ 匹配零或多层目录。
/// </summary>
public sealed class GlobMatcherTests
{
    [Theory]
    [InlineData("*.cs", "a.cs", true)]
    [InlineData("*.cs", "sub/a.cs", false)]   // * 不跨目录
    [InlineData("*.cs", "a.txt", false)]
    [InlineData("**/*.cs", "a.cs", true)]     // **/ 匹配零层目录 → 根目录文件也应命中
    [InlineData("**/*.cs", "sub/a.cs", true)]
    [InlineData("**/*.cs", "a/b/c.cs", true)]
    [InlineData("src/*.cs", "src/a.cs", true)]
    [InlineData("src/*.cs", "src/a/b.cs", false)]
    [InlineData("?.cs", "a.cs", true)]
    [InlineData("?.cs", "ab.cs", false)]
    [InlineData("**", "any/thing/here.txt", true)]
    [InlineData("a/**/b.cs", "a/b.cs", true)]
    [InlineData("a/**/b.cs", "a/x/y/b.cs", true)]
    [InlineData("a/**/b.cs", "x/b.cs", false)]
    public void IsMatch_AppliesGlobSemantics(string pattern, string path, bool expected)
    {
        Assert.Equal(expected, GlobMatcher.IsMatch(pattern, path, ignoreCase: false));
    }

    [Fact]
    public void IsMatch_WithIgnoreCase_MatchesDifferentCase()
    {
        Assert.True(GlobMatcher.IsMatch("*.CS", "a.cs", ignoreCase: true));
        Assert.False(GlobMatcher.IsMatch("*.CS", "a.cs", ignoreCase: false));
    }

    [Fact]
    public void IsMatch_SpecialCharacters_AreEscaped()
    {
        // '.' 与 '+' 等正则有特殊含义的字符应被按字面处理。
        Assert.True(GlobMatcher.IsMatch("a+b.c", "a+b.c", ignoreCase: false));
        Assert.False(GlobMatcher.IsMatch("a+b.c", "axbxc", ignoreCase: false));
    }
}
