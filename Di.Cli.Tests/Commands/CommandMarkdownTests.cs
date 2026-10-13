using Di.Cli.Commands;

namespace Di.Cli.Tests.Commands;

/// <summary>
/// <see cref="CommandMarkdown"/>（~/.di/commands/&lt;name&gt;.md 解析）的单元测试：
/// frontmatter 严格性对齐 <c>SkillMarkdownTests</c>（必需字段 / 重复字段 / 未知字段 / BOM/CRLF）。
/// </summary>
public sealed class CommandMarkdownTests
{
    [Fact]
    public void Parse_HappyPath()
    {
        var cmd = CommandMarkdown.Parse("""
            ---
            description: 提交当前改动
            argument-hint: 提交信息
            ---
            运行 git add -A 并提交。
            """, "commit");

        Assert.Equal("commit", cmd.Name);
        Assert.Equal("提交当前改动", cmd.Description);
        Assert.Equal("提交信息", cmd.ArgumentHint);
        Assert.Equal("运行 git add -A 并提交。", cmd.Body);
    }

    [Fact]
    public void Parse_NoArgumentHint_IsNull()
    {
        var cmd = CommandMarkdown.Parse("""
            ---
            description: 清理临时文件
            ---
            rm -rf 临时目录。
            """, "cleanup");

        Assert.Null(cmd.ArgumentHint);
        Assert.Equal("清理临时文件", cmd.Description);
    }

    [Fact]
    public void Parse_MissingFrontmatter_Throws()
    {
        Assert.Throws<CommandFormatException>(() => CommandMarkdown.Parse("hello", "hello"));
    }

    [Fact]
    public void Parse_UnclosedFrontmatter_Throws()
    {
        Assert.Throws<CommandFormatException>(() => CommandMarkdown.Parse("---\ndescription: hi\n", "hello"));
    }

    [Fact]
    public void Parse_MissingDescription_Throws()
    {
        Assert.Throws<CommandFormatException>(() => CommandMarkdown.Parse("---\nargument-hint: x\n---\nbody", "hello"));
    }

    [Fact]
    public void Parse_EmptyBody_Throws()
    {
        Assert.Throws<CommandFormatException>(() => CommandMarkdown.Parse("---\ndescription: hi\n---\n  ", "hello"));
    }

    [Fact]
    public void Parse_InvalidName_Throws()
    {
        // 命令名 = 文件名，必须匹配小写字母/数字/连字符规则。
        Assert.Throws<CommandFormatException>(() => CommandMarkdown.Parse("---\ndescription: hi\n---\nbody", "BadName"));
        Assert.Throws<CommandFormatException>(() => CommandMarkdown.Parse("---\ndescription: hi\n---\nbody", "-bad"));
    }

    [Fact]
    public void Parse_DuplicateDescription_Throws()
    {
        Assert.Throws<CommandFormatException>(() =>
            CommandMarkdown.Parse("---\ndescription: a\ndescription: b\n---\nbody", "hello"));
    }

    [Fact]
    public void Parse_UnknownFields_Ignored()
    {
        var cmd = CommandMarkdown.Parse("---\ndescription: hi\nlicense: MIT\nname: 不应覆盖\n---\nbody", "hello");

        Assert.Equal("hi", cmd.Description);
        Assert.Equal("hello", cmd.Name);   // 命令名始终取文件名
    }

    [Fact]
    public void Parse_BomAndCrlf_Tolerated()
    {
        var cmd = CommandMarkdown.Parse("﻿\r\n---\r\ndescription: hi\r\n---\r\nbody\r\n", "hello");

        Assert.Equal("hi", cmd.Description);
        Assert.Equal("body", cmd.Body);
    }

    [Fact]
    public void Parse_DescriptionWithColonsAndQuotes_Kept()
    {
        var cmd = CommandMarkdown.Parse("---\ndescription: \"发 PR：引用 #42\"\n---\nbody", "hello");

        Assert.Equal("发 PR：引用 #42", cmd.Description);
    }
}