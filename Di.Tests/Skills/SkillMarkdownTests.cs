using Core.Skills;

namespace Di.Tests.Skills;

/// <summary>
/// 针对 <see cref="SkillMarkdown"/>（SKILL.md 解析）的单元测试。
/// 格式：<c>---</c> 包裹的 frontmatter（name/description）+ 正文指令。
/// </summary>
public sealed class SkillMarkdownTests
{
    [Fact]
    public void Parse_ExtractsNameDescriptionAndInstructions()
    {
        var md = """
            ---
            name: backend-tests
            description: 运行并修复后端测试
            ---
            运行 dotnet test 的工作流：改代码后先 build 再 test。
            """;

        var skill = SkillMarkdown.Parse(md);

        Assert.Equal("backend-tests", skill.Name);
        Assert.Equal("运行并修复后端测试", skill.Description);
        Assert.Contains("先 build 再 test", skill.Instructions);
    }

    [Fact]
    public void Parse_ValuesMayContainColonsAndQuotes()
    {
        var md = "---\nname: deploy\ndescription: \"部署到 staging: 先 build\"\n---\nbody";

        var skill = SkillMarkdown.Parse(md);

        Assert.Equal("deploy", skill.Name);
        Assert.Equal("部署到 staging: 先 build", skill.Description);
    }

    [Fact]
    public void Parse_LeadingBomAndBlankLines_AreTolerated()
    {
        var md = "﻿\n\n---\nname: x\ndescription: y\n---\nbody";

        var skill = SkillMarkdown.Parse(md);

        Assert.Equal("x", skill.Name);
        Assert.Equal("body", skill.Instructions);
    }

    [Fact]
    public void Parse_WindowsCrLf_IsHandled()
    {
        var md = "---\r\nname: win\r\ndescription: crlf 文件\r\n---\r\nline1\r\nline2";

        var skill = SkillMarkdown.Parse(md);

        Assert.Equal("win", skill.Name);
        Assert.Contains("line1", skill.Instructions);
        Assert.Contains("line2", skill.Instructions);
    }

    [Fact]
    public void Parse_UnknownFields_AreIgnored()
    {
        var md = "---\nname: x\ndescription: y\nallowed-tools: read_file\n---\nbody";

        var skill = SkillMarkdown.Parse(md);

        Assert.Equal("x", skill.Name);
        Assert.Equal("y", skill.Description);
    }

    [Fact]
    public void Parse_MissingFrontmatter_Throws()
    {
        var ex = Assert.Throws<SkillFormatException>(() => SkillMarkdown.Parse("没有 frontmatter"));

        Assert.Contains("---", ex.Message);
    }

    [Fact]
    public void Parse_UnclosedFrontmatter_Throws()
    {
        Assert.Throws<SkillFormatException>(() => SkillMarkdown.Parse("---\nname: x\ndescription: y\nbody"));
    }

    [Fact]
    public void Parse_MissingName_Throws()
    {
        Assert.Throws<SkillFormatException>(() => SkillMarkdown.Parse("---\ndescription: y\n---\nbody"));
    }

    [Fact]
    public void Parse_MissingDescription_Throws()
    {
        Assert.Throws<SkillFormatException>(() => SkillMarkdown.Parse("---\nname: x\n---\nbody"));
    }

    [Fact]
    public void Parse_EmptyBody_Throws()
    {
        Assert.Throws<SkillFormatException>(() => SkillMarkdown.Parse("---\nname: x\ndescription: y\n---\n\n"));
    }
}
