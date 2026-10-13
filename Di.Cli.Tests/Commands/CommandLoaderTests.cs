using Di.Cli.Commands;

namespace Di.Cli.Tests.Commands;

/// <summary>
/// <see cref="CommandLoader"/>（~/.di/commands/*.md → 注册表）的单元测试：
/// 临时目录风格对齐 <c>SkillRepositoryTests</c>（无效跳过告警 / 重名跳过 / 坏目录不崩）。
/// </summary>
public sealed class CommandLoaderTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("di-commands-").FullName;
    private readonly List<string> _warnings = [];
    private readonly SlashCommandRegistry _registry = BuiltinCommands.CreateRegistry();

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); }
        catch { /* 清理失败忽略 */ }
    }

    private string CommandsDir => Path.Combine(_root, "commands");
    private static readonly int BuiltinCount = BuiltinCommands.Create().Count;

    private void WriteCommand(string name, string description, string body = "body")
    {
        Directory.CreateDirectory(CommandsDir);
        File.WriteAllText(Path.Combine(CommandsDir, $"{name}.md"),
            $"---\ndescription: {description}\n---\n{body}");
    }

    [Fact]
    public void Load_MissingDir_LoadsNothing()
    {
        Assert.Equal(0, CommandLoader.LoadInto(_registry, CommandsDir, _warnings.Add));
        Assert.Equal(BuiltinCount, _registry.List().Count);   // 仅内置
    }

    [Fact]
    public async Task Load_ValidCommands_BecomeTurnCommands()
    {
        WriteCommand("commit", "提交改动", "git add -A && git commit");

        Assert.Equal(1, CommandLoader.LoadInto(_registry, CommandsDir, _warnings.Add));
        Assert.Empty(_warnings);
        Assert.True(_registry.TryGet("commit", out var cmd));

        var ctx = new CommandContext(_registry, new FakeRunner(), [], new StringWriter(), []);
        var result = await cmd!.Handler("第一个提交", ctx);

        Assert.NotNull(result.TurnMessage);
        Assert.Contains("git add -A && git commit", result.TurnMessage);
        Assert.Contains("第一个提交", result.TurnMessage);
    }

    [Fact]
    public void Load_UserCommands_MergeWithBuiltins()
    {
        WriteCommand("commit", "提交改动");

        CommandLoader.LoadInto(_registry, CommandsDir, _warnings.Add);

        Assert.Equal(BuiltinCount + 1, _registry.List().Count);
        Assert.Contains("commit", _registry.List().Select(c => c.Name));
    }

    [Fact]
    public void Load_NameConflictWithBuiltin_WarnsAndSkips()
    {
        WriteCommand("model", "不该覆盖内置");

        Assert.Equal(0, CommandLoader.LoadInto(_registry, CommandsDir, _warnings.Add));
        Assert.Contains(_warnings, w => w.Contains("重名", StringComparison.Ordinal));
        Assert.True(_registry.TryGet("model", out var builtin));
        Assert.Equal("切换模型", builtin!.Description);   // 内置优先
    }

    [Fact]
    public void Load_InvalidFile_WarnsAndSkips()
    {
        Directory.CreateDirectory(CommandsDir);
        File.WriteAllText(Path.Combine(CommandsDir, "broken.md"), "not frontmatter");

        Assert.Equal(0, CommandLoader.LoadInto(_registry, CommandsDir, _warnings.Add));
        Assert.Contains(_warnings, w => w.Contains("跳过无效命令", StringComparison.Ordinal));
    }
}