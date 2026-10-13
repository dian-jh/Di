namespace Di.Cli.Commands;

/// <summary>
/// 命令执行结果。对齐 Pi 的 <c>AgentOperationResponse</c> 语义：返回值说明命令是否产生回合——
/// 同步应答（<see cref="Handled"/> / <see cref="Quit"/>）或请求宿主跑一个回合
/// （<see cref="Turn"/>）。宿主（REPL / RPC）拿到 Turn 后用自己的回合机制执行，命令本身不依赖任何前端。
/// </summary>
public sealed record CommandResult(bool Exit = false, string? TurnMessage = null)
{
    /// <summary>命令已处理，无回合。</summary>
    public static CommandResult Handled => new();

    /// <summary>命令请求退出会话（如 /exit）。</summary>
    public static CommandResult Quit => new(Exit: true);

    /// <summary>命令请求宿主运行一个回合（如 /skill &lt;名&gt; &lt;参数&gt;、用户命令）。</summary>
    public static CommandResult Turn(string message) => new(TurnMessage: message);
}