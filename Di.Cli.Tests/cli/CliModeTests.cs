using Di.Cli;

namespace Di.Cli.Tests.Cli;

/// <summary>
/// <see cref="CliMode.Resolve"/> 的单元测试：纯函数，按 CLI 参数 + TTY 探测决定运行模式
/// （镜像 Pi 的 resolveAppMode）。悲观覆盖：非 TTY、显式 --mode 覆盖、短路径优先级。
/// </summary>
public sealed class CliModeTests
{
    private static CliArgs Args(string[] positionals, string? mode = null, bool print = false,
        bool version = false, bool help = false, string? listModels = null) => new()
    {
        Positionals = positionals,
        Mode = mode,
        Print = print,
        Version = version,
        Help = help,
        ListModels = listModels,
    };

    private const bool Tty = true;
    private const bool NotTty = false;

    [Fact]
    public void Resolve_TtyTtyNoPrompt_Interactive()
    {
        Assert.Equal(AppMode.Interactive, CliMode.Resolve(Args([]), Tty, Tty));
    }

    [Fact]
    public void Resolve_PositionalPrompt_Print()
    {
        Assert.Equal(AppMode.Print, CliMode.Resolve(Args(["读一下 README"]), Tty, Tty));
    }

    [Fact]
    public void Resolve_PrintFlag_Print()
    {
        Assert.Equal(AppMode.Print, CliMode.Resolve(Args([], print: true), Tty, Tty));
    }

    [Fact]
    public void Resolve_StdinNotTty_Print()
    {
        Assert.Equal(AppMode.Print, CliMode.Resolve(Args([]), NotTty, Tty));
    }

    [Fact]
    public void Resolve_StdoutNotTty_Print()
    {
        Assert.Equal(AppMode.Print, CliMode.Resolve(Args([]), Tty, NotTty));
    }

    [Fact]
    public void Resolve_ExplicitModeJson_JsonEvenOnTty()
    {
        Assert.Equal(AppMode.Json, CliMode.Resolve(Args([], mode: "json"), Tty, Tty));
    }

    [Fact]
    public void Resolve_ExplicitModeJson_OverridesPositional()
    {
        Assert.Equal(AppMode.Json, CliMode.Resolve(Args(["prompt"], mode: "json"), Tty, Tty));
    }

    [Fact]
    public void Resolve_ExplicitModePrint_PrintEvenOnTty()
    {
        Assert.Equal(AppMode.Print, CliMode.Resolve(Args([], mode: "print"), Tty, Tty));
    }

    [Fact]
    public void Resolve_ExplicitModeInteractive_OverridesPositionalAndNonTty()
    {
        Assert.Equal(AppMode.Interactive, CliMode.Resolve(Args(["prompt"], mode: "interactive"), NotTty, NotTty));
    }

    [Fact]
    public void Resolve_ExplicitModeRpc_Rpc()
    {
        Assert.Equal(AppMode.Rpc, CliMode.Resolve(Args([], mode: "rpc"), Tty, Tty));
    }

    [Fact]
    public void Resolve_Version_PriorityOverModeAndPrompt()
    {
        Assert.Equal(AppMode.Version, CliMode.Resolve(Args(["prompt"], mode: "json", version: true), Tty, Tty));
    }

    [Fact]
    public void Resolve_Help_PriorityOverEverything()
    {
        Assert.Equal(AppMode.Help, CliMode.Resolve(Args([], mode: "json", help: true), Tty, Tty));
    }

    [Fact]
    public void Resolve_ListModels_PriorityOverPrompt()
    {
        Assert.Equal(AppMode.ListModels, CliMode.Resolve(Args(["prompt"], listModels: ""), Tty, Tty));
    }
}
