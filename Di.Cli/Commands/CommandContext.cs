using Core.AgentLoop;
using Core.Skills;

namespace Di.Cli.Commands;

/// <summary>
/// 命令调用上下文：能力（registry / runner / skills / output）+ 宿主注入的回合执行器与展示开关。
/// <see cref="Pinned"/> 是可变固定集合，归属调用方（REPL 与 RPC 各自持有实例），跨命令保持，
/// 供 /skill、/skills 读改。/help 经 <see cref="Registry"/> 推导帮助文本。
/// REPL 提供 <see cref="RunTurn"/>（回合类命令由它执行）；RPC 为 null，收到 Turn 结果时按协议
/// 拒绝（turn_not_supported，docs/tui-rpc.md §2.5）。
/// </summary>
public sealed record CommandContext(
    SlashCommandRegistry Registry,
    IAgentRunner Runner,
    IReadOnlyList<Skill> Skills,
    TextWriter Output,
    List<Skill> Pinned,
    bool UseAnsi = true,
    Func<string, CancellationToken, Task>? RunTurn = null,
    CancellationToken CancellationToken = default);