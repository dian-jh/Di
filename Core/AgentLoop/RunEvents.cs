using Common.Events;

namespace Core.AgentLoop;

/// <summary>
/// 回合生命周期事件（供日志旁路订阅，见 Core/Logging/DiLog.cs 与 docs/modules/logging.md）。
///
/// 注意：这两个事件<b>故意不继承 <see cref="AgentLoopEvent"/></b>，尽管语义上是"循环观察"：
/// RPC 模式的 <c>Di.Cli/modes/RpcMode.cs</c> 对 AgentLoopEvent 是全量 switch（未知子类型直接抛
/// ArgumentOutOfRangeException），TS TUI 的 <c>tui/src/rpc/codec.ts</c> 对未知 kind 同样抛
/// ProtocolError（防静默吞掉结构错误）——把新事件塞进 AgentLoopEvent 家族等于扩线协议契约。
/// 它们只被日志消费，与 UI 无关，故以普通 <see cref="Event"/> 发布；基于总线"向上派发"规则，
/// <c>CreateConsumer&lt;AgentLoopEvent&gt;()</c>（RPC/TUI/EventRenderer）收不到它们。
/// </summary>
public sealed record ModelCallStarted(int Iteration) : Event;

/// <summary>一次 agent 运行开始（用户输入进入 Runner）。由 <c>AgentRunner.RunAsync</c> 发布，
/// 是所有前端（REPL / headless / RPC）用户输入的公共入口。</summary>
public sealed record RunStarted(string UserMessage) : Event;