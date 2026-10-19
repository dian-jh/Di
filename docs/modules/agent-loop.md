# Core.AgentLoop —— ReAct 循环与跨回合宿主

> 模块文档。回答"一次回合如何跑、循环怎么停、跨回合记忆怎么维护、为什么这个请求布局能命中缓存"。
> 上一级入口：`docs/README.md`；CLI 侧的会话契约见 `docs/cli.md`（`IAgentRunner`）。

## 目的与职责

harness 的核心执行引擎：

- **`ReAct`**：单回合的 ReAct 主循环（无外部依赖，可独立复用）；
- **`AgentRunner`**：跨回合宿主——模型路由、历史累加 / 裁剪、环境快照、Skills 注入（`IAgentRunner` 实现）；
- **`EnvironmentSnapshot`**：注入工作目录与自助查询提示。

## 实现原理

### ReAct 循环（`Core/AgentLoop/ReAct.cs`）

- **轨迹** = 历史 + 用户消息；循环内：模型决策 → 追加 → 有工具调用则执行并回填观察 → 再决策。
- **停止条件**（`AgentStopReason`，`Core/AgentLoop/AgentResult.cs`）：无工具调用的回答 / 最终输出工具 /
  达到显式正整数 `MaxIterations` / 上下文预算暂停 `ContextLimit` / 不可重试模型错误 / 软停止 `Interrupted`。默认迭代上限为 0（不限轮数）。
- **软停止（相位边界）**：可选构造参数 `IInterruptSignal? interrupt`（`Core/AgentLoop/IInterruptSignal.cs`）。
  循环在**两个相位边界**轮询 `IsStopRequested`：进入模型相位前（不发起模型调用）、执行工具前（不执行任何工具），
  命中则经 `StopInterrupted` **正常返回** `AgentStopReason.Interrupted`（携带已有轨迹 / 文本 / usage / cost），
  并发布 `AgentLoopEvent.Interrupted`。已开始的相位不打断、未开始的不启动；与硬取消（`CancellationToken`
  异常路径）正交。完整语义与状态机见 `docs/interrupt.md`。
- **工具失败 = 观察结果**（`ExecuteToolAsync`）：异常 → `error: ...` 观察文本回填模型，模型可据此纠正，
  不是崩溃。
- **历史协议完整性**（`AgentRunner.SanitizeHistory`）：回合停止后移除尾部未配齐结果的整个工具调用组，
  包括最终输出工具前已执行的部分结果，避免下一回合请求携带悬空调用。
- **成本跨轮累计**（`CombineCost`）：`ModelResponse.Cost` 累加 → `AgentResult.Cost` / `TurnCompleted.Cost`。
- **消息布局（缓存关键）**：`[稳定 system prompt] + [完整轨迹] + [易变 SystemContext 于请求末尾]`。
  稳定前缀逐字节不变、跨回合单调增长 → 命中 DeepSeek 前缀缓存；易变上下文（skill 指令）只在末尾，
  不进入持久历史。
- 发布 `AgentLoopEvent`（`TextDelta` / `TurnCompleted` / `ToolStarted` / `ToolCompleted` / `RunFailed` /
  `Interrupted`），自身不渲染（见 `docs/modules/events.md`）。

### AgentRunner（`Core/AgentLoop/AgentRunner.cs`）

- 按当前模型名经工厂解析 `IChatModel`（`CurrentModel` 可运行中切换）。
- **环境快照最小化注入 + 工具自取**（参考 pi 设计）：只注入"工作目录 + 自取提示"，仓库详情
  （分支/改动/提交）改为模型需要时用 bash `git status` / `git log` 自助查询，避免为低频易变信息
  每回合支付 git 进程与 token（Windows 上每次 git spawn ≈100ms+，且注入内容拉高 TTFT）。
  `_lastSnapshotText` 去重：内容恒定 → 首次追加后留在缓存前缀零重复支付；被历史裁剪裁掉后自动重置重新注入。
- **跨回合记忆裁剪（预算独占 + 显式轮数兜底）**：token 预算非 null 时**只有预算裁剪**
  （`TrimHistoryByTokens`，估算见 `TokenEstimator`，至少保留最近 1 轮），轮数裁剪完全不参与；
  预算来源（预算制，di 上下文压缩阶段一已落地）：宿主注入 `Core.ContextManagement.BudgetPolicy`
  时取 soft 水位线（`B_input × SoftRatio`，B_input 已扣输出/安全预留）；未注入时退回
  `ContextWindow × AgentLoopOptions.HistoryBudgetRatio`（默认 0.5）。**降级路径**：token 预算为
  null（未知上下文窗口，`contextWindowProvider` 返回 null 或解析失败）时，仅当调用方**显式**传
  `maxHistoryTurns > 0` 才按轮数兜底（`TrimHistory`，默认 0 / 不传 = 无轮数上限，历史原样保留）。
  每次工具执行前按当前轨迹（含用户、assistant 和已完成工具结果）更新共享 holder
  `InputBudgetTracker`；回合末同步裁剪后的记忆估算（B_current，
  §6.3），供 L1 工具结果预算控制的预测判定读取。`ResetHistory()` 同时重置快照标记与 holder。
- **Skills 注入**：有 skill 时追加 `load_skill` 工具、执行器包一层 `SkillAwareExecutor`；
  `ActiveSkills`（固定 `/skill` + 每回合自动匹配）逐回合构建 SystemContext（见 `docs/modules/skills.md`）。

## 代码入口

| 文件（相对仓库根） | 职责 |
|---|---|
| `Core/AgentLoop/ReAct.cs` | ReAct 主循环（`RunStreamingAsync` / 私有 `RunCoreAsync` / `ExecuteToolAsync` / `CombineCost`） |
| `Core/AgentLoop/AgentRunner.cs` | 跨回合宿主（模型路由 / 历史裁剪（轮数 + token 预算）/ 快照 / skills） |
| `Core/AgentLoop/IAgentRunner.cs` | 宿主抽象——CLI 唯一依赖的会话契约（见 `docs/cli.md` §2.1）；含 `InterruptSignal` 会话级软停止属性 |
| `Core/AgentLoop/IInterruptSignal.cs` | 软停止信号抽象——循环依赖它读取意图，不认识前端实现（见 `docs/interrupt.md`） |
| `Core/AgentLoop/AgentRequest.cs` | 一次运行输入（UserMessage / History / Tools / ToolExecutor / Validator / SystemContext） |
| `Core/AgentLoop/AgentResult.cs` | 一次运行结局（Answer / Trajectory / Usage / Cost / StopReason / Failure） |
| `Core/AgentLoop/AgentLoopEvent.cs` | 领域事件（见 `docs/modules/events.md`） |
| `Core/AgentLoop/AgentLoopOptions.cs` | 循环配置（`MaxIterations` / `SystemPrompt` / `FinalOutputTool` / `MaxTokens` / `ReasoningEffort`） |
| `Core/AgentLoop/EnvironmentSnapshot.cs` | 最小环境快照：工作目录与 git 自助查询提示，不启动 git 进程 |
| `Core/AgentLoop/IToolExecutor.cs` / `Core/AgentLoop/IToolValidator.cs` | 执行与安全 / 权限挂点，loop 不认识具体工具 |

## 关键符号

- `ReAct`、`AgentRunner`、`IAgentRunner`
- `AgentRequest`、`AgentResult`、`AgentStopReason`（`Answer` / `FinalOutputTool` / `MaxIterations` / `ContextLimit` / `Error` / `Interrupted`）
- `IInterruptSignal`（`IsStopRequested`）、`ReAct.StopInterrupted`、`IAgentRunner.InterruptSignal`
- `AgentLoopOptions`（含 `HistoryBudgetRatio`）、`EnvironmentSnapshot`
- `AgentRunner.TrimHistoryByTokens`（token 预算裁剪）、`Core.Llm.TokenEstimator`（估算口径 ~4 字符/token）
- `AgentRequest.ContextTokenBudget` / `AgentStopReason.ContextLimit`：模型调用前估算完整 history、reasoning、tool-call arguments 和工具 schema；超预算时暂停并保留完整轨迹。估算使用 UTF-8 字节数除以 3 加固定开销及 schema 近似，非 tokenizer 精算，不能保证不超窗；未知上下文窗口时没有请求级预算保护。ContextLimit 后不裁掉暂停任务；换用更大预算继续，或显式 `ResetHistory()` 后另开任务。
- `Core.ContextManagement.BudgetPolicy`（预算制裁剪：soft 水位线为预算）、`InputBudgetTracker`（B_current 共享 holder）
- `IToolExecutor`、`IToolValidator`

## 调用关系

```
Di.Cli/Repl.cs ── IAgentRunner.RunAsync ──► AgentRunner
   ├─ 捕获环境快照（变化才追加历史）
   ├─ 构建 SystemContext（skill 广告 + 激活 skill 指令）
   └─ ReAct.RunStreamingAsync(AgentRequest)
       ├─ IChatModel.StreamAsync（→ docs/modules/llm.md：RetryingChatModel → ChatModelClient → 适配器）
       ├─ 事件 → IEventBus（→ docs/modules/events.md）
       ├─ 有工具调用 → IToolExecutor 执行（→ docs/modules/tools.md，或 SkillAwareExecutor → docs/modules/skills.md）
       └─ 无工具调用 → AgentResult
```

## 已实现能力与测试

| 能力 | 落点 | 测试 |
|---|---|---|
| ReAct 主循环（流式 / 非流式双路径） | `Core/AgentLoop/ReAct.cs` | `Di.Tests/AgentLoop/ReActTests.cs` |
| 五种停止条件 | `Core/AgentLoop/AgentResult.cs` | `Di.Tests/AgentLoop/ReActTests.cs` |
| 软停止：相位边界收敛（B0/B2 不发起模型调用、B1 不执行工具、携带已有用量） | `ReAct.RunCoreAsync` / `StopInterrupted` | `Di.Tests/AgentLoop/ReActInterruptTests.cs` |
| 迭代预算（防无限循环） | `AgentLoopOptions.MaxIterations` | `Di.Tests/AgentLoop/ReActTests.cs` |
| 工具失败 = 观察，不是崩溃 | `ReAct.ExecuteToolAsync` | `Di.Tests/AgentLoop/ReActTests.cs` |
| 不可重试模型错误 → 干净结局 | `ReAct.RunCoreAsync` | `Di.Tests/AgentLoop/ReActTests.cs` |
| 跨回合记忆 + 整回合裁剪（轮数 + token 预算） | `AgentRunner` | `Di.Tests/AgentLoop/AgentRunnerTests.cs` |
| 预算制裁剪（soft 水位线 / 退回旧口径 / B_current 上报） | `AgentRunner` + `Core.ContextManagement` | `Di.Tests/ContextManagement/AgentRunnerBudgetTrimmingTests.cs` |
| 环境快照（最小化注入 + 工具自取） | `Core/AgentLoop/EnvironmentSnapshot.cs` | `Di.Tests/AgentLoop/EnvironmentSnapshotTests.cs` |
| 最终输出工具 | `AgentLoopOptions.FinalOutputTool` | `Di.Tests/AgentLoop/ReActTests.cs` |
| 工具校验缝 | `IToolValidator`（MVP 传 null） | —（预留） |
| 成本跨轮累计 | `ReAct.CombineCost` | `Di.Tests/AgentLoop/ReActTests.cs` |
| Skills 广告 + load_skill 工具注入 | `AgentRunner` | `Di.Tests/AgentLoop/AgentRunnerTests.cs` |

## 关联文档

- `docs/interrupt.md` —— 中断（软停止 / 硬取消 / 退出）的语义、相位边界状态机与前端接线
- `docs/cli.md` —— `IAgentRunner` / `AgentResult` / 事件流的 CLI 契约视角（换语言重写时保留什么）
- `docs/modules/llm.md` —— 模型层（`IChatModel` / 重试 / 成本）
- `docs/modules/tools.md` / `docs/modules/skills.md` —— 工具与 skill 的注入 / 执行
- `docs/modules/events.md` —— 事件流与 UI 解耦
- `docs/architecture.md` —— 一次回合的完整数据流时序
