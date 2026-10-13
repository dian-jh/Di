using Di.Cli;

namespace Di.Cli.Tests.Cli;

/// <summary>
/// <see cref="CliArgsParser"/> 的单元测试：纯参数解析（string[] → CliArgs 数据 + 诊断）。
/// 悲观覆盖：未知选项、缺值选项、非法 --mode、"--" 截断、`--list-models` 可选参数。
/// </summary>
public sealed class CliArgsTests
{
    private static (CliArgs Args, IReadOnlyList<CliDiagnostic> Diags) Parse(params string[] args)
        => CliArgsParser.Parse(args);

    [Fact]
    public void Parse_NoArgs_EmptyArgsNoDiagnostics()
    {
        var (args, diags) = Parse();

        Assert.Empty(args.Positionals);
        Assert.Empty(diags);
        Assert.False(args.Print);
        Assert.False(args.Version);
        Assert.False(args.Help);
        Assert.Null(args.Model);
    }

    [Fact]
    public void Parse_Positionals_CapturedInOrder()
    {
        var (args, diags) = Parse("hello", "world");

        Assert.Equal(["hello", "world"], args.Positionals);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_ShortModelFlag_TakesValue()
    {
        var (args, diags) = Parse("-m", "deepseek-v4-pro");

        Assert.Equal("deepseek-v4-pro", args.Model);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_LongModelFlag_TakesValue()
    {
        var (args, diags) = Parse("--model", "deepseek-flash");

        Assert.Equal("deepseek-flash", args.Model);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_ProviderFlag_TakesValue()
    {
        var (args, diags) = Parse("--provider", "deepseek");

        Assert.Equal("deepseek", args.Provider);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_PrintFlag_True()
    {
        var (args, diags) = Parse("--print");

        Assert.True(args.Print);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_ModeJson_Value()
    {
        var (args, diags) = Parse("--mode", "json");

        Assert.Equal("json", args.Mode);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_VersionFlag_True()
    {
        var (args, diags) = Parse("--version");

        Assert.True(args.Version);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_InfoFlag_True()
    {
        var (args, diags) = Parse("--info");

        Assert.True(args.Info);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_ShortHelpFlag_True()
    {
        var (args, diags) = Parse("-h");

        Assert.True(args.Help);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_LongHelpFlag_True()
    {
        var (args, diags) = Parse("--help");

        Assert.True(args.Help);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_NoSession_True()
    {
        var (args, diags) = Parse("--no-session");

        Assert.True(args.NoSession);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_NoAnsi_True()
    {
        var (args, diags) = Parse("--no-ansi");

        Assert.True(args.NoAnsi);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_Thinking_TakesValue()
    {
        var (args, diags) = Parse("--thinking", "high");

        Assert.Equal("high", args.Thinking);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_ListModels_WithoutPattern_EmptyString()
    {
        var (args, diags) = Parse("--list-models");

        Assert.Equal("", args.ListModels);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_ListModels_WithPattern_TakesValue()
    {
        var (args, diags) = Parse("--list-models", "deepseek");

        Assert.Equal("deepseek", args.ListModels);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_ListModels_StopsAtFlag_DoesNotConsumeFlag()
    {
        var (args, diags) = Parse("--list-models", "--version");

        Assert.Equal("", args.ListModels);
        Assert.True(args.Version);   // --version 仍是旗标，没被吞成 pattern
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_Stats_TakesRequiredValue()
    {
        var (args, diags) = Parse("--stats", "session.jsonl");

        Assert.Equal("session.jsonl", args.Stats);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_StatsMissingValue_AddsDiagnosticError()
    {
        var (args, diags) = Parse("--stats");

        Assert.Null(args.Stats);
        Assert.Contains(diags, d => d.IsError);
    }

    [Fact]
    public void Parse_SkillEval_TakesRequiredValue()
    {
        var (args, diags) = Parse("--skill-eval", "cases.json");

        Assert.Equal("cases.json", args.SkillEval);
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_SkillEvalMissingValue_AddsDiagnosticError()
    {
        var (args, diags) = Parse("--skill-eval");

        Assert.Null(args.SkillEval);
        Assert.Contains(diags, d => d.IsError);
    }

    [Fact]
    public void Parse_UnknownFlag_AddsDiagnosticError()
    {
        var (args, diags) = Parse("--bogus", "hi");

        Assert.Equal(["hi"], args.Positionals);
        var diag = Assert.Single(diags);
        Assert.True(diag.IsError);
        Assert.Contains("--bogus", diag.Message);
        Assert.Contains("--bogus", args.UnknownFlags);
    }

    [Fact]
    public void Parse_UnknownShortFlag_AddsDiagnosticError()
    {
        var (args, diags) = Parse("-x");

        Assert.True(Assert.Single(diags).IsError);
        Assert.Contains("-x", args.UnknownFlags);
    }

    [Fact]
    public void Parse_ModelMissingValue_AddsDiagnosticError()
    {
        var (_, diags) = Parse("--model");

        var diag = Assert.Single(diags);
        Assert.True(diag.IsError);
        Assert.Contains("--model", diag.Message);
    }

    [Fact]
    public void Parse_ModelFlagFollowedByFlag_ReportsMissingValue()
    {
        // -m 后跟另一个旗标：不把旗标当值吞掉，而是报"缺值"。
        var (args, diags) = Parse("-m", "--version");

        Assert.Null(args.Model);
        Assert.True(args.Version);
        Assert.True(Assert.Single(diags).IsError);
    }

    [Fact]
    public void Parse_InvalidModeValue_AddsDiagnosticError()
    {
        var (args, diags) = Parse("--mode", "bogus");

        Assert.Equal("bogus", args.Mode);
        var diag = Assert.Single(diags);
        Assert.True(diag.IsError);
        Assert.Contains("bogus", diag.Message);
    }

    [Fact]
    public void Parse_DoubleDash_RestArePositionalsEvenIfDashed()
    {
        var (args, diags) = Parse("--", "--version", "-m");

        Assert.Equal(["--version", "-m"], args.Positionals);
        Assert.False(args.Version);   // "--" 之后不再解析旗标
        Assert.Empty(diags);
    }

    [Fact]
    public void Parse_FlagsBeforePositional_Combine()
    {
        var (args, diags) = Parse("--print", "-m", "deepseek-flash", "跑测试");

        Assert.True(args.Print);
        Assert.Equal("deepseek-flash", args.Model);
        Assert.Equal(["跑测试"], args.Positionals);
        Assert.Empty(diags);
    }
}
