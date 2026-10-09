namespace Di.Cli;

/// <summary>外层 REPL 的展示配置。</summary>
public sealed class ReplOptions
{
    /// <summary>输入提示符。</summary>
    public string Prompt { get; set; } = "di> ";

    /// <summary>/help 输出的命令说明。</summary>
    public string HelpText { get; set; } =
        "命令：/help 帮助 · /clear 清屏并清空记忆 · /model &lt;模型名&gt; 切换模型 · " +
        "/skills 列出 skill · /skill &lt;名称&gt; 激活/停用（语义匹配自动加载）· /exit 退出";

    /// <summary>回合开始、等待模型首个输出时显示的"进行中"状态行。</summary>
    public string WorkingStatusText { get; set; } = "⟳ 正在请求模型…";

    /// <summary>
    /// 是否允许 ANSI 控制序列（清行）。真实终端为 true；输出重定向（管道/文件）时
    /// 应为 false，避免把控制序列写进捕获输出。
    /// </summary>
    public bool UseAnsi { get; set; } = true;
}
