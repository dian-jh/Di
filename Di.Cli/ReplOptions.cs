namespace Di.Cli;

/// <summary>外层 REPL 的展示配置。</summary>
public sealed class ReplOptions
{
    /// <summary>输入提示符。</summary>
    public string Prompt { get; set; } = "di> ";

    /// <summary>回合开始、等待模型首个输出时显示的"进行中"状态行。</summary>
    public string WorkingStatusText { get; set; } = "⟳ 正在请求模型…";

    /// <summary>
    /// 是否允许 ANSI 控制序列（清行）。真实终端为 true；输出重定向（管道/文件）时
    /// 应为 false，避免把控制序列写进捕获输出。
    /// </summary>
    public bool UseAnsi { get; set; } = true;
}
