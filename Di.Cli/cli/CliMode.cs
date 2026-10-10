namespace Di.Cli;

/// <summary>CLI 运行模式（对应 Pi 的 AppMode）。</summary>
public enum AppMode
{
    /// <summary>交互 REPL。</summary>
    Interactive,

    /// <summary>headless 单发：文本输出。</summary>
    Print,

    /// <summary>headless 单发：JSON 输出。</summary>
    Json,

    /// <summary>RPC（预留，尚未实现）。</summary>
    Rpc,

    /// <summary>打印版本后退出。</summary>
    Version,

    /// <summary>打印帮助后退出。</summary>
    Help,

    /// <summary>列出可用模型后退出。</summary>
    ListModels,
}

/// <summary>
/// 运行模式解析（纯函数，对应 Pi 的 <c>resolveAppMode</c>）。
/// TTY 探测由宿主传入（<c>!Console.IsInputRedirected</c> 等），解析器本身不碰 I/O，
/// 因此任何语言的 CLI 重写都能复用同样的规则。
/// </summary>
public static class CliMode
{
    public static AppMode Resolve(CliArgs args, bool stdinIsTty, bool stdoutIsTty)
    {
        // 短路径优先：版本 / 帮助 / 列模型，命中即退出，不进入交互。
        if (args.Version)
            return AppMode.Version;
        if (args.Help)
            return AppMode.Help;
        if (args.ListModels is not null)
            return AppMode.ListModels;

        // 显式 --mode 优先；未指定时按"提示词/TTY"推导。
        return args.Mode switch
        {
            "json" => AppMode.Json,
            "print" => AppMode.Print,
            "interactive" => AppMode.Interactive,
            "rpc" => AppMode.Rpc,
            _ => args.Positionals.Count > 0
                ? AppMode.Print                       // di "prompt" → 单发
                : args.Print || !stdinIsTty || !stdoutIsTty
                    ? AppMode.Print                   // --print 或管道/重定向 → 单发
                    : AppMode.Interactive,
        };
    }
}
