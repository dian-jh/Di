using Di.Cli.Commands;

namespace Di.Cli.Tests.Commands;

/// <summary>
/// <see cref="SlashCommandRegistry"/>（对齐 Pi 的 SlashCommands 服务）的单元测试：
/// 注册 / 列举 / 重名 / 按名解析 / 输入拆分 / 帮助推导。
/// </summary>
public sealed class SlashCommandRegistryTests
{
    private static SlashCommand Cmd(string name) =>
        new(name, $"{name} 的描述", null, (_, _) => Task.FromResult(CommandResult.Handled));

    [Fact]
    public void Register_And_List_SortsByName()
    {
        var registry = new SlashCommandRegistry();
        registry.Register(Cmd("model"));
        registry.Register(Cmd("clear"));

        Assert.Equal(["clear", "model"], registry.List().Select(c => c.Name));
    }

    [Fact]
    public void Register_Duplicate_Throws()
    {
        var registry = new SlashCommandRegistry();
        registry.Register(Cmd("model"));

        Assert.Throws<InvalidOperationException>(() => registry.Register(Cmd("model")));
    }

    [Fact]
    public void RegisterAll_RegistersEveryCommand()
    {
        var registry = new SlashCommandRegistry();
        registry.RegisterAll([Cmd("exit"), Cmd("help")]);

        Assert.Equal(2, registry.List().Count);
    }

    [Fact]
    public void Register_NullOrBlankName_Throws()
    {
        var registry = new SlashCommandRegistry();

        Assert.ThrowsAny<ArgumentException>(() => registry.Register(Cmd(" ")));
    }

    [Fact]
    public void TryGet_Hit_And_Miss()
    {
        var registry = new SlashCommandRegistry();
        registry.Register(Cmd("exit"));

        Assert.True(registry.TryGet("exit", out var cmd));
        Assert.Equal("exit", cmd!.Name);
        Assert.False(registry.TryGet("nope", out _));
    }

    [Fact]
    public void Split_KeepsSlash_And_TrimsArgs()
    {
        Assert.Equal(("/model", "deepseek-chat"), SlashCommandRegistry.Split("/model deepseek-chat"));
        Assert.Equal(("/exit", string.Empty), SlashCommandRegistry.Split("/exit"));
        Assert.Equal(("/skill", "backend-tests"), SlashCommandRegistry.Split("/skill  backend-tests  "));
    }

    [Fact]
    public void Format_IncludesHint_OnlyWhenPresent()
    {
        var withHint = new SlashCommand("model", "切换模型", "<模型名>", (_, _) => Task.FromResult(CommandResult.Handled));

        Assert.Equal("  /model <模型名> —— 切换模型", SlashCommandRegistry.Format(withHint));
        Assert.Equal("  /exit —— exit 的描述", SlashCommandRegistry.Format(Cmd("exit")));
    }

    [Fact]
    public void BuildHelp_ListsAllRegistered()
    {
        var registry = new SlashCommandRegistry();
        registry.Register(Cmd("exit"));
        registry.Register(Cmd("clear"));

        var help = registry.BuildHelp();
        Assert.Contains("可用命令", help);
        Assert.Contains("/clear", help);
        Assert.Contains("/exit", help);
    }
}