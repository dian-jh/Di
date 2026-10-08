namespace Di.Cli;

/// <summary>外层 REPL 的展示配置。</summary>
public sealed class ReplOptions
{
    /// <summary>输入提示符。</summary>
    public string Prompt { get; init; } = "di> ";

    /// <summary>/help 输出的命令说明。</summary>
    public string HelpText { get; init; } =
        "命令：/help 帮助 · /clear 清屏 · /model &lt;模型名&gt; 切换模型 · /exit 退出";
}
