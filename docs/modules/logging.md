# Core.Logging —— 运行日志（jcode 格式文本落盘）

> 模块文档。回答"运行日志写在哪、什么格式、怎么经事件总线落盘、写盘失败会不会打断主流程"。
> 上一级入口：`docs/README.md`；落盘位置约定见 `docs/di-home.md`；事件总线见 `docs/modules/events.md`。

## 目的与职责

把一次 CLI 运行的**回合生命周期时间线**落地为面向人读的文本日志
（`~/.di/logs/di-YYYY-MM-DD.log`，按日一个文件），对齐 `C:\Users\52143\.jcode\logs` 的
jcode 写法——每行 `[yyyy-MM-dd HH:mm:ss.fff] [LEVEL] message`（本地时间）。

记录三类关键事实（一次回合从开始到结束的完整链路）：

1. **用户输入**：`run: started user_input=…`（所有前端在 `AgentRunner.RunAsync` 一个点发布，全覆盖）；
2. **模型调用发起**：`llm: call_started iteration=N`；
3. **模型响应返回**：`llm: call_completed iteration=N duration_ms=… tokens_in=… finish=…`
   （`duration_ms` 由日志侧按事件时间戳算，响应返回时刻即该行时间戳）。

完整文本（逐字输出 / 工具观察全文）**不进 .log**——那是噪声，且会话 JSONL
（`Core.Sessions`）已经无损留存；.log 只做可扫视的时间线。

## 实现原理

- **EventBus 旁路**：`DiLog.Subscribe(bus)` 订阅一次 `IEvent`（push 模式，fan-out），把
  `AgentLoopEvent` 生命周期事件翻译成日志行；`DiLog.Log(level, message)` 供宿主写
  `di starting` / 组合根装配等非事件行。事件在总线上的多态派发保证"一次订阅、每事件恰好一次"。
- **事件 → 日志行**（全量映射，未列出的流式增量事件一律跳过）：

  | 事件 | 行 | 级别 |
  |---|---|---|
  | `RunStarted(u)` | `run: started user_input=<折叠>` | INFO |
  | `ModelCallStarted(i)` | `llm: call_started iteration=i` | INFO |
  | `TurnCompleted(i,…)` | `llm: call_completed iteration=i duration_ms=… tokens_in=… tokens_out=… cache_read=… cost=… finish=<kind>` | INFO |
  | `RunFailed(f)` | `llm: run_failed code=… error=<折叠> duration_ms=…` | ERROR |
  | `ToolStarted` / `ToolCompleted` | `tool: started name=…` / `tool: completed name=…`，失败 `tool: failed name=… error=…` | INFO / WARN |
  | `Interrupted` | `run: interrupted` | INFO |
  | `TextDelta` / `ReasoningDelta` / `ToolCallDelta` | 跳过（逐字噪声；完整文本在会话 JSONL） | — |

- **时长测量在日志侧**：sink 记最近一次 `ModelCallStarted` 的创建时刻（单槽；
  ReAct 同时只在途一次模型调用），`TurnCompleted` / `RunFailed` 时按事件时间戳差算 `duration_ms`——
  不扩 `TurnCompleted` 载荷，避免触碰 RPC 序列化。
- **按日轮转 + 逐行 flush**：日期键变化即重开文件（`Clock` 可注入，测试用假时钟）；每行写后
  flush，进程中断不丢已写行；`FileShare.ReadWrite` 允许 tail。
- **静默兜底**：目录不可写 / 磁盘满 / 被删 → 丢弃当行、绝不抛异常——日志是旁路观察，
  绝不影响主流程（与 `EventBus` 的异常隔离叠加生效）。
- **折叠与截断**：多行 / 连续空白折成单行；单字段超 300 字符截断加 `…`（完整文本在会话 JSONL）。

## 代码入口

| 文件（相对仓库根） | 职责 |
|---|---|
| `Core/Logging/DiLog.cs` | sink：`DiLogOptions` 时钟/根目录、`Subscribe(IEventBus)`、`Log(level, message)`、事件→行映射、轮转 |
| `Core/Logging/DiLogOptions.cs` | `DiLogOptions`（`RootDirectory` / `Clock`）+ `LogLevel`（Info/Warn/Error） |
| `Core/AgentLoop/RunEvents.cs` | 日志生命周期事件：`RunStarted` / `ModelCallStarted`（**非** `AgentLoopEvent` 家族，见下） |
| `Core/Configuration/DiHome.cs` | `DiHome.LogsDirectory`（`~/.di/logs` 唯一权威路径源） |
| `Di.Cli/CliHost.cs` | 组合根：构造 `DiLog` → 订阅总线 → 写 `di starting` → 挂入释放链（Dispose 写 `di exiting`） |

## 关键约束：生命周期事件不进 AgentLoopEvent 家族

`RunStarted` / `ModelCallStarted` 语义上属循环观察，但**故意只继承 `Event`**，不继承
`AgentLoopEvent`。原因（防后人"修正"回去炸掉线协议）：

- `Di.Cli/modes/RpcMode.cs` 的 `EventPayload` 对 `AgentLoopEvent` 是**全量 switch**，
  未知子类型直接抛 `ArgumentOutOfRangeException`；
- TS TUI 的 `tui/src/rpc/codec.ts` 对未知 `kind` 同样抛 `ProtocolError`（防静默吞掉结构错误）；
- 这两个事件只被日志消费，与 UI 无关——塞进 AgentLoopEvent 家族等于为日志功能扩线协议契约
  （`docs/tui-rpc.md` 是唯一权威）。

基于总线"向上派发以发布时静态类型为天花板"的规则，非 AgentLoopEvent 的事件不会进入
`CreateConsumer<AgentLoopEvent>()` 的通道（RPC / TUI / EventRenderer 无感知）。
`ReAct.Emit` 因此是**泛型方法**：保留调用点的具体静态类型，AgentLoopEvent 订阅者照常收到全部事件。

## 调用关系

```
Di.Cli/CliHost.cs（组合根）：new DiLog() → Subscribe(IEventBus) → Log("di starting …")
        │  IEventBus（push 订阅）
        ├─ Core.AgentLoop/AgentRunner.cs ── RunStarted(用户输入)   → run: started
        └─ Core.AgentLoop/ReAct.cs ── ModelCallStarted / TurnCompleted / ToolStarted /
                                       ToolCompleted / RunFailed / Interrupted → llm:/tool: 行
DiLog.Dispose（宿主释放）→ 写 di exiting → 关文件 → 退订
```

## 已实现能力与测试

| 能力 | 落点 | 测试 |
|---|---|---|
| jcode 格式行（`[yyyy-MM-dd HH:mm:ss.fff] [LEVEL] msg`） | `DiLog.Log` | `Di.Tests/Logging/DiLogTests.cs` |
| 每日一个文件 + 按 Clock 轮转 | `DiLog` | `Di.Tests/Logging/DiLogTests.cs` |
| 用户输入 → 模型发起 → 模型返回 完整时间线（含 `duration_ms` / 用量 / finish） | `DiLog` 事件映射 | `Di.Tests/Logging/DiLogTests.cs` |
| 失败（`RunFailed` → ERROR）/ 工具错误（WARN）/ 流增量跳过 | `DiLog` 事件映射 | `Di.Tests/Logging/DiLogTests.cs` |
| 写盘失败静默兜底（不抛、不打断主流程） | `DiLog` | `Di.Tests/Logging/DiLogTests.cs` |
| 产生点：`RunStarted` / `ModelCallStarted` 发布 | `AgentRunner.RunAsync` / `ReAct.RunCoreAsync` | `Di.Tests/AgentLoop/AgentRunnerTests.cs` + `ReActTests.cs` |
| Dispose 幂等 + 写 `di exiting` | `DiLog.Dispose` | `Di.Tests/Logging/DiLogTests.cs` |

## 关联文档

- `docs/di-home.md` —— `~/.di` 家目录结构、logs/ 落点与所有权规则
- `docs/modules/events.md` —— 事件总线（push 订阅 / 多态派发 / 异常隔离）
- `docs/modules/sessions.md` —— 会话 JSONL（完整文本的权威落点，与 .log 互补）
- `docs/modules/agent-loop.md` —— 事件产生点（`ReAct` / `AgentRunner`）