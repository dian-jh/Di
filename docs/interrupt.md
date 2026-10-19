# 中断（软停止）设计

> **唯一权威**：回合中断的语义、状态机、停止契约与各前端接线。跨切面设计文档（跨 `Core.AgentLoop`、
> `Di.Cli`、RPC 三层），与 `docs/tui.md` 同型。上层入口见 `docs/README.md`。
> 源码为准；本文变更须与实现同步。

## 1. 目的

用户可以随时按键（终端 Ctrl+C）**停下当前的 agent 回合**，而不必等它自己跑完。
需求的关键约束：**停下不是"立刻杀死"，而是"在下一个安全边界停下"** —— 已开始的工作不打断、
未开始的工作不启动，回合状态保持一致，可以安全落盘、下一回合接着用。

## 2. 三个正交概念（先对齐）

中断不是一个东西，是三样必须分开的机制：

| 概念 | 语义 | 机制 | 触发 |
|---|---|---|---|
| **软停止** | 在下一个**相位边界**停下；已开始的相位跑完，未开始的不启动 | `IInterruptSignal`（**标志位**，循环在边界轮询） | 第一次 Ctrl+C / RPC `interrupt` |
| **硬取消** | 立刻打断在途工作（HTTP 流、子进程） | `CancellationToken`（传进模型流与工具执行） | 第二次 Ctrl+C |
| **进程退出** | 结束整个会话 | 生命周期 token（`InterruptCoordinator.Lifetime`） | 无回合时按下 Ctrl+C |

**软停止与硬取消正交，不能互相替代**：软停止救不了卡死的工具（`python` 死循环、`npm test` 挂起），
所以必须保留硬取消作为升级手段。启用会话 checkpoint 时，硬取消会保留已完成步骤；若工具已开始但结果未持久化，恢复会明确拒绝自动继续并要求核查副作用。

## 3. 状态机：回合的相位与边界

一个回合是**模型相位 ⇄ 工具相位**的交替循环（`Core/AgentLoop/ReAct.cs` 的 `RunCoreAsync`）：

```
P0 准备（快照 / skills / SystemContext）      [AgentRunner.RunAsync]
   │
B0 ◄── 检查点：进入模型相位前
   │
P1 模型相位（StreamAsync 流式）
   │
B1 ◄── 检查点：执行工具前
   │
P2 判定：有无 tool_calls？ ── 无 ─► 正常回答（Answer）
   │ 有
P3 工具相位（for each call in 当前批）
   │
B2 ◄── 检查点：回到模型相位前（= B0）
   └──► 回到 P1
```

**软停止只在这两个边界被观测**（B0/B2 是同一处：进入模型相位前）：

- **B0/B2**（进入模型相位前）：不再发起模型调用。
- **B1**（执行工具前）：不再执行任何工具。

## 4. 决策表（中断落在哪里 → 做什么）

| 中断到达时 | 边界 | 行为 | stop_reason |
|---|---|---|---|
| 提示词还没发给模型（P0 中 / P1 前） | B0 | 不发起模型调用，直接结束 | `Interrupted` |
| 已发给模型、模型正在回 / 刚回完 | B1 | 让模型跑完并渲染；**不执行任何工具** | `Interrupted` |
| 工具调用进行中 | B2 | 让**当前批**工具跑完；不发起下一次模型调用 | `Interrupted` |
| 工具跑完、刚准备发模型 | B2 | 不再发起模型调用 | `Interrupted` |

顺序细节（`ReAct.RunCoreAsync`）：模型给出**无工具调用的纯文本回答**时走正常 `Answer` 收敛，
**优先于 B1 检查** —— 模型已经给出完整答案，没什么可中断的。

## 5. 停止契约：软停止是"正常收敛"，不是异常

软停止**不抛异常**，`ReAct` 正常返回一个 `AgentResult`（`StopInterrupted` 方法）：

- **`StopReason = AgentStopReason.Interrupted`**（第五种停止原因，与 `Answer`/`FinalOutputTool`/`MaxIterations`/`Error` 并列）。
- **`Answer`** = 轨迹里最后一个 assistant 文本（模型已产出的可见文本，通常已随流式事件显示）。
- **`Usage` / `Cost`** = 中断<b>前</b>已发生的累计量（中断前花掉的钱照常上报）。
- **`Trajectory`** = 完整轨迹（含已跑完的工具结果）。
- 同时发布 **`AgentLoopEvent.Interrupted`** 事件，供流式 UI（TUI）即时提示。

**落盘**：因为软停止是正常返回，宿主的既有路径自然生效 —— `SessionLog.AppendTurn` 照常记录该回合
（这与硬取消不同：硬取消走 `OperationCanceledException` 异常路径；启用 checkpoint 时异常处理会尝试恢复已持久化轨迹，工具结果未知则锁住同进程重试）。`AgentRunner` 的
`SanitizeHistory` 会把尾部"未被响应的 tool_calls"按良构规则处理掉（见 §7）。

## 6. 实现与接线

### 6.1 循环侧（`Core.AgentLoop`）

- **`IInterruptSignal`**（`Core/AgentLoop/IInterruptSignal.cs`）：`bool IsStopRequested { get; }`。
  `ReAct` 在 B0/B2 与 B1 两处轮询它；可空 = 不可软中断。
- **`ReAct`**（`Core/AgentLoop/ReAct.cs`）：构造参数 `IInterruptSignal? interrupt`（可空）。
  两处边界检查 + `StopInterrupted` 返回。**只加这两处，不改循环结构。**
- **`IAgentRunner.InterruptSignal`**（`Core/AgentLoop/IAgentRunner.cs`）：会话级可设属性，
  与 `CurrentModel` / `ActiveSkills` 同款 —— 前端持有并设置，harness 只读；`AgentRunner.RunAsync`
  每回合把它转发给 `ReAct`。

### 6.2 前端侧（`Di.Cli`）

- **`InterruptCoordinator`**（`Di.Cli/InterruptCoordinator.cs`）：实现 `IInterruptSignal`。
  把"按下次数"映射成递进强度：

  | 按下 | 有回合时 | 返回值（`e.Cancel`） |
  |---|---|---|
  | 第 1 次 | **软停止**：置位 `IsStopRequested` | `true`（抑制进程终止） |
  | 第 2 次 | **硬取消**：`Cancel()` 当前回合的取消源 | `true`（让回合干净收尾后再退出） |
  | 无回合 | 取消 `Lifetime`、放行退出 | `false` |

  常见使用下与旧行为一致：第一次 Ctrl+C 结束当前回合，第二次（回合已结束）退出进程。
- **REPL 接线**（`Di.Cli/Repl.cs`）：`RunAsync` 里 `_runner.InterruptSignal = _interrupt`；
  `Program.cs` 把 `Console.CancelKeyPress` 映射到 `InterruptCoordinator.RequestInterrupt`。
- **渲染**（`Di.Cli/EventRenderer.cs`）：`AgentLoopEvent.Interrupted` → 一行状态提示；
  `RenderResult` 对 `StopReason.Interrupted` 补一行说明（文本已流式显示，不重复回显）。
- **RPC / TUI**（`Di.Cli/modes/RpcMode.cs`、`docs/tui-rpc.md`）：`stop_reason:"interrupted"`、
  事件 `kind:"interrupted"`。RPC 的 `interrupt` 请求目前仍映射为**硬取消**
  （`stop_reason:"cancelled"`），软停止接线见 §7。

## 7. 已知边界与后续（MVP 取舍）

- **RPC / TUI 的软停止**：RPC `interrupt` 目前是硬取消（协议契约 `stop_reason:"cancelled"` 未变）。
  要接软停止需协议协调（TUI 侧二次按下语义），`ResultPayload` 已预留 `interrupted` 映射。
- **硬取消与恢复边界**：启用 checkpoint 时，每条 assistant 响应和工具 started/completed 状态同步持久化。异常/硬取消后 Runner 尝试从 checkpoint 更新内存历史；已完成工具结果不会因同进程重试而丢失。若日志中存在 started 但无 completed 的工具，结果未知，Runner 锁住继续请求，直到调用方核查副作用后显式重置/新建会话。未开始的工具调用在恢复轨迹中以“未执行”观察补齐，模型不会收到可直接重放的悬空调用。没有配置 checkpoint（如 `--no-session`）时，硬取消不会提供此恢复保证。
- **一批多工具调用的粒度**：软停止在**批边界**观测，不打断批内已开始的工具；整批跑完才收敛。
- **在途模型调用不打断**：模型相位中途按下软停止，等模型跑完（避免半截 assistant 消息）。
  要立刻断流用第二次 Ctrl+C（硬取消）。

## 8. 代码入口

| 文件（相对仓库根） | 职责 |
|---|---|
| `Core/AgentLoop/IInterruptSignal.cs` | 软停止信号抽象（循环依赖它，不认识前端） |
| `Core/AgentLoop/ReAct.cs` | 两处相位边界检查 + `StopInterrupted`（`RunCoreAsync`） |
| `Core/AgentLoop/AgentResult.cs` | `AgentStopReason.Interrupted` |
| `Core/AgentLoop/AgentLoopEvent.cs` | `AgentLoopEvent.Interrupted` |
| `Core/AgentLoop/IAgentRunner.cs` / `AgentRunner.cs` | `InterruptSignal` 会话级属性 + 转发给 `ReAct` |
| `Di.Cli/InterruptCoordinator.cs` | 递进式中断协调器（软 → 硬 → 退出），实现 `IInterruptSignal` |
| `Di.Cli/Program.cs` | `Console.CancelKeyPress` → `RequestInterrupt` |
| `Di.Cli/Repl.cs` | 注入信号到 runner；软停止走正常结果路径 |
| `Di.Cli/EventRenderer.cs` | `Interrupted` 事件 / 结果的终端渲染 |
| `Di.Cli/modes/RpcMode.cs` | `stop_reason:"interrupted"` / 事件 `kind:"interrupted"` |

## 9. 已实现能力与测试

| 能力 | 落点 | 测试 |
|---|---|---|
| 边界 B0/B2：未开始模型调用不启动 | `ReAct.RunCoreAsync` | `Di.Tests/AgentLoop/ReActInterruptTests.cs` |
| 边界 B1：不执行工具、保留模型文本 | `ReAct.RunCoreAsync` | 同上 |
| 工具跑完后收敛（保留工具结果） | `ReAct.RunCoreAsync` | 同上 |
| 无工具调用的纯文本回答优先于中断 | `ReAct.RunCoreAsync` | 同上 |
| Interrupted 结果携带已发生 usage/cost | `ReAct.StopInterrupted` | 同上 |
| Interrupted 事件 | `AgentLoopEvent.Interrupted` | 同上 |
| 递进式中断（软 → 硬 → 退出） | `InterruptCoordinator` | `Di.Cli.Tests/InterruptCoordinatorTests.cs` |
| REPL 接线 + 软停止渲染/落盘 | `Repl` / `EventRenderer` | `Di.Cli.Tests/ReplTests.cs`、`EventRendererTests.cs` |
| RPC 线格式 | `RpcMode` | `Di.Cli.Tests/modes/RpcModeTests.cs` |

## 关联文档

- `docs/modules/agent-loop.md` —— ReAct 循环与跨回合宿主（本特性的循环侧）
- `docs/tui-rpc.md` —— RPC 线协议（`stop_reason` / 事件 `kind`）
- `docs/cli.md` —— CLI 契约与 `IAgentRunner`
- `docs/roadmap.md` —— 缺口 #3（回合级中断）
