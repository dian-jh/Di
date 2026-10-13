namespace Di.Cli.Commands;

/// <summary>斜杠命令处理器：参数 + 上下文 → 执行结果。</summary>
public delegate Task<CommandResult> SlashCommandHandler(string args, CommandContext context);

/// <summary>
/// 斜杠命令贡献：元数据 + 处理器（对齐 Pi 的 <c>SlashCommandContribution</c>：name /
/// description / argumentHint / run）。内置命令与用户命令（<c>~/.di/commands/&lt;name&gt;.md</c>）
/// 统一注册到 <see cref="SlashCommandRegistry"/>，两种前端（REPL 与 RPC/TUI）共用同一份注册表。
/// </summary>
public sealed record SlashCommand(
    string Name,
    string Description,
    string? ArgumentHint,
    SlashCommandHandler Handler);