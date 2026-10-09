using Core.Skills;

namespace Di.Tests.Skills;

/// <summary>
/// 针对 <see cref="SkillMarkdown"/>（SKILL.md 解析）的单元测试。
/// 对齐 Microsoft Agent Framework：name 格式与目录名校验、description 长度、metadata/allowed-tools、
/// 重复字段拒绝、未知字段忽略。
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

        var skill = SkillMarkdown.Parse(md, expectedName: "backend-tests");

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
    public void Parse_MetadataNested_IsParsed()
    {
        var md = "---\nname: x\ndescription: y\nmetadata:\n  author: contoso\n  version: \"2.1\"\n---\nbody";

        var skill = SkillMarkdown.Parse(md);

        Assert.Equal("contoso", skill.Metadata["author"]);
        Assert.Equal("2.1", skill.Metadata["version"]);
    }

    [Fact]
    public void Parse_AllowedTools_SpaceDelimited()
    {
        var md = "---\nname: x\ndescription: y\nallowed-tools: read_file write_file\n---\nbody";

        var skill = SkillMarkdown.Parse(md);

        Assert.Equal(["read_file", "write_file"], skill.AllowedTools);
    }

    [Fact]
    public void Parse_UnknownTopLevelFields_AreIgnored()
    {
        var md = "---\nname: x\ndescription: y\nunknown-field: whatever\n---\nbody";

        var skill = SkillMarkdown.Parse(md);

        Assert.Equal("x", skill.Name);
        Assert.Empty(skill.Metadata);
        Assert.Empty(skill.AllowedTools);
    }

    [Fact]
    public void Parse_CommentsInFrontmatter_AreIgnored()
    {
        var md = "---\n# 这是注释\nname: x\ndescription: y\n---\nbody";

        var skill = SkillMarkdown.Parse(md);

        Assert.Equal("x", skill.Name);
    }

    [Fact]
    public void Parse_NameMismatchingDirectory_Throws()
    {
        var ex = Assert.Throws<SkillFormatException>(() =>
            SkillMarkdown.Parse("---\nname: x\ndescription: y\n---\nbody", expectedName: "other"));

        Assert.Contains("目录名", ex.Message);
    }

    [Fact]
    public void Parse_InvalidNameFormat_Throws()
    {
        Assert.Throws<SkillFormatException>(() =>
            SkillMarkdown.Parse("---\nname: BadName\ndescription: y\n---\nbody"));
        Assert.Throws<SkillFormatException>(() =>
            SkillMarkdown.Parse("---\nname: -bad\ndescription: y\n---\nbody"));
        Assert.Throws<SkillFormatException>(() =>
            SkillMarkdown.Parse("---\nname: bad--name\ndescription: y\n---\nbody"));
    }

    [Fact]
    public void Parse_OverlongName_Throws()
    {
        var longName = new string('a', SkillMarkdown.MaxNameLength + 1);
        Assert.Throws<SkillFormatException>(() =>
            SkillMarkdown.Parse($"---\nname: {longName}\ndescription: y\n---\nbody"));
    }

    [Fact]
    public void Parse_OverlongDescription_Throws()
    {
        var longDesc = new string('中', SkillMarkdown.MaxDescriptionLength + 1);
        Assert.Throws<SkillFormatException>(() =>
            SkillMarkdown.Parse($"---\nname: x\ndescription: {longDesc}\n---\nbody"));
    }

    [Fact]
    public void Parse_DuplicateRecognizedField_Throws()
    {
        var ex = Assert.Throws<SkillFormatException>(() =>
            SkillMarkdown.Parse("---\nname: x\nname: y\ndescription: z\n---\nbody"));

        Assert.Contains("重复", ex.Message);
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
