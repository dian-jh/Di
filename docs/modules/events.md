# Common.Events —— 进程内事件总线

> 模块文档。回答"事件总线解决什么问题、怎么用、事件从哪来到哪去"。
> 上一级入口：`docs/README.md`；生产者/消费者见 `docs/modules/agent-loop.md` 与 `docs/cli.md`。

## 目的与职责

进程内**事件总线**：把 harness 核心（ReAct 循环）与 UI / 日志等旁路消费方解耦。
ReAct 只**发布**事件、不渲染；CLI 从总线**消费**并流式渲染；日志、遥测可挂同一总线旁路观察。
参考微软 eShopOnContainers / .NET 官方事件总线模型。

## 实现原理

- **两种消费模式**（各自独立、互不影响）：
  - **订阅（push）**：`Subscribe`（按处理器类型 / 实例 / 委托三种重载），fan-out，每个订阅者收到每条事件，
    适合日志、安全、遥测等旁路观察。返回 `IDisposable` 退订令牌。
  - **消费（pull）**：`CreateConsumer` → `await foreach`，拉取有序事件流，适合 CLI UI 渲染（按序 + 背压）。
- **多态派发**：事件沿继承链向上投递——订阅 / 消费基类（如 `AgentLoopEvent`）收到其全部具体子类事件；
  同一处理器注册在具体类型与基类两层时会收到两次事件，应只订阅最需要的层级。
- **异常隔离**：单个订阅者抛异常不中断其它订阅者；`EventBusOptions.OnHandlerError` 配置错误接收器后
  转发并吞掉，未配置则在发布结束后抛出（见 §代码入口）。

## 代码入口

| 文件（相对仓库根） | 职责 |
|---|---|
| `Common/Events/IEventBus.cs` | 总线接口：`PublishAsync` / `Subscribe`（3 重载）/ `CreateConsumer` |
| `Common/Events/InMemoryEventBus.cs` | 内存实现：push 订阅 + pull 通道双路径 |
| `Common/Events/Event.cs` / `Common/Events/IEvent.cs` | 事件基类（Id / CreatedAt / CorrelationId）与标记接口 |
| `Common/Events/IEventHandler.cs` | push 订阅者契约（`HandleAsync`） |
| `Common/Events/IEventConsumer.cs` | pull 消费者契约（`ConsumeAsync` / `TryRead`，Dispose 退订） |
| `Common/Events/EventBusOptions.cs` | 异常隔离（`OnHandlerError`）与容量配置 |
| `Common/Events/EventBusServiceCollectionExtensions.cs` | DI 注册扩展 |

## 关键符号

- `IEventBus` / `InMemoryEventBus`
- `IEventHandler<TEvent>`（push）、`IEventConsumer<TEvent>`（pull）
- `Event`（基类，record）、`IEvent`（标记接口）
- `EventBusOptions`
- 领域事件：`AgentLoopEvent` 及其具体事件（`Core/AgentLoop/AgentLoopEvent.cs`）——下表是领域事件
  的**唯一权威表**；`docs/cli.md` §2.2 只做契约视角复述，改动以本表为准。

| 事件 | 负载 | 含义 |
|---|---|---|
| `TextDelta` | `Delta` | 模型流式增量文本（逐字） |
| `ReasoningDelta` | `Delta` | 推理内容增量（M1 新增，转发 `ModelEvent.ReasoningDelta`；TUI 展示思考） |
| `ToolCallDelta` | `ToolCallId` / `Name` / `Arguments` | 工具调用增量（M1 新增，转发 `ModelEvent.ToolCallDelta`；`Arguments` 为迄今累计的原始 JSON 串，可能未完成） |
| `ToolStarted` / `ToolCompleted` | 调用 / 观察（含 `IsError`） | 工具生命周期 |
| `TurnCompleted` | 迭代号、`TokenUsage`、`UsageCost?`、`FinishReason` | 一次模型调用结束 |
| `RunFailed` | `LlmFailure` | 循环层失败（不可重试） |

## 调用关系（数据流）

```
ReAct（Core/AgentLoop/ReAct.cs）── PublishAsync(AgentLoopEvent)
        │   IEventBus（InMemoryEventBus）
        ├─ push 订阅：日志 / 遥测旁路（IEventHandler）
        └─ pull 消费：Repl.RunTurnAsync 建消费者
            └─ EventRenderer（Di.Cli/EventRenderer.cs）流式渲染
```

回合边界用 `IEventConsumer.TryRead` 排空：一次运行结束后把本回合全部事件取走、不等待新事件。

## 已实现能力与测试

| 能力 | 落点 | 测试 |
|---|---|---|
| push 订阅 + pull 消费、多态派发、退订令牌 | `InMemoryEventBus` | `Di.Tests/Events/EventBusTests.cs` |
| 异常隔离（坏订阅者不拖垮循环） | `EventBusOptions.OnHandlerError` | `Di.Tests/Events/EventBusTests.cs` |
| 循环 / UI 解耦（事件实时渲染） | `Di.Cli/Repl.cs`（`RunTurnAsync`）+ `EventRenderer` | `Di.Cli.Tests/ReplTests.cs`、`Di.Cli.Tests/EventRendererTests.cs` |

## 关联文档

- `docs/modules/agent-loop.md` —— 事件生产者（ReAct）与领域事件定义
- `docs/cli.md` —— 事件消费方（EventRenderer 渲染、回合边界排空）
