# Core.AgentLoop —— ReAct 循环与跨回合宿主

> 模块文档。回答"一次回合如何跑、循环怎么停、跨回合记忆怎么维护、为什么这个请求布局能命中缓存"。
> 上一级入口：`docs/README.md`；CLI 侧的会话契约见 `docs/cli.md`（`IAgentRunner`）。

## 目的与职责

harness 的核心执行引擎：

- **`ReAct`**：单回合的 ReAct 主循环（无外部依赖，可独立复用）；
- **`AgentRunner`**：跨回合宿主——模型路由、历史累加 / 裁剪、环境快照、Skills 注入（`IAgentRunner` 实现）；
- **`EnvironmentSnapshot`**：把工作区状态（git 分支 / 最近提交 / 未提交变更）注入上下文。

## 实现原理

### ReAct 循环（`Core/AgentLoop/ReAct.cs`）

- **轨迹** = 历史 + 用户消息；循环内：模型决策 → 追加 → 有工具调用则执行并回填观察 → 再决策。
- **停止条件**（`AgentStopReason`，`Core/AgentLoop/AgentResult.cs`）：无工具调用的回答 / 最终输出工具 /
  达到 `MaxIterations`（`AgentLoopOptions`，默认 24）/ 不可重试模型错误。
- **工具失败 = 观察结果**（`ExecuteToolAsync`）：异常 → `error: ...` 观察文本回填模型，模型可据此纠正，
  不是崩溃。
- **成本跨轮累计**（`CombineCost`）：`ModelResponse.Cost` 累加 → `AgentResult.Cost` / `TurnCompleted.Cost`。
- **消息布局（缓存关键）**：`[稳定 system prompt] + [完整轨迹] + [易变 SystemContext 于请求末尾]`。
  稳定前缀逐字节不变、跨回合单调增长 → 命中 DeepSeek 前缀缓存；易变上下文（skill 指令）只在末尾，
  不进入持久历史。
- 发布 `AgentLoopEvent`（`TextDelta` / `TurnCompleted` / `ToolStarted` / `ToolCompleted` / `RunFailed`），
  自身不渲染（见 `docs/modules/events.md`）。

### AgentRunner（`Core/AgentLoop/AgentRunner.cs`）

- 按当前模型名经工厂解析 `IChatModel`（`CurrentModel` 可运行中切换）。
- **环境快照 append-on-change 进持久历史**（`_lastSnapshotText` 去重）：只在内容变化时追加，
  稳定时留在缓存前缀零重复支付；被历史裁剪裁掉后自动重置重新注入。
- **历史按整回合裁剪**到最近 N 轮（默认 10，`maxHistoryTurns`）；`ResetHistory()` 同时重置快照标记。
- **Skills 注入**：有 skill 时追加 `load_skill` 工具、执行器包一层 `SkillAwareExecutor`；
  `ActiveSkills`（固定 `/skill` + 每回合自动匹配）逐回合构建 SystemContext（见 `docs/modules/skills.md`）。

## 代码入口

| 文件（相对仓库根） | 职责 |
|---|---|
| `Core/AgentLoop/ReAct.cs` | ReAct 主循环（`RunStreamingAsync` / 私有 `RunCoreAsync` / `ExecuteToolAsync` / `CombineCost`） |
| `Core/AgentLoop/AgentRunner.cs` | 跨回合宿主（模型路由 / 历史裁剪 / 快照 / skills） |
| `Core/AgentLoop/IAgentRunner.cs` | 宿主抽象——CLI 唯一依赖的会话契约（见 `docs/cli.md` §2.1） |
| `Core/AgentLoop/AgentRequest.cs` | 一次运行输入（UserMessage / History / Tools / ToolExecutor / Validator / SystemContext） |
| `Core/AgentLoop/AgentResult.cs` | 一次运行结局（Answer / Trajectory / Usage / Cost / StopReason / Failure） |
| `Core/AgentLoop/AgentLoopEvent.cs` | 领域事件（见 `docs/modules/events.md`） |
| `Core/AgentLoop/AgentLoopOptions.cs` | 循环配置（`MaxIterations` / `SystemPrompt` / `FinalOutputTool` / `MaxTokens` / `ReasoningEffort`） |
| `Core/AgentLoop/EnvironmentSnapshot.cs` | 工作区状态渲染（尽力而为：git 缺失 / 超时静默省略；变更概览紧凑截断到 `MaxStatusLines` 行；git 输出显式按 UTF-8 解码） |
| `Core/AgentLoop/IToolExecutor.cs` / `Core/AgentLoop/IToolValidator.cs` | 执行与安全 / 权限挂点，loop 不认识具体工具 |

## 关键符号

- `ReAct`、`AgentRunner`、`IAgentRunner`
- `AgentRequest`、`AgentResult`、`AgentStopReason`（`Answer` / `FinalOutputTool` / `MaxIterations` / `Error`）
- `AgentLoopOptions`、`EnvironmentSnapshot`
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
| 四种停止条件 | `Core/AgentLoop/AgentResult.cs` | `Di.Tests/AgentLoop/ReActTests.cs` |
| 迭代预算（防无限循环） | `AgentLoopOptions.MaxIterations` | `Di.Tests/AgentLoop/ReActTests.cs` |
| 工具失败 = 观察，不是崩溃 | `ReAct.ExecuteToolAsync` | `Di.Tests/AgentLoop/ReActTests.cs` |
| 不可重试模型错误 → 干净结局 | `ReAct.RunCoreAsync` | `Di.Tests/AgentLoop/ReActTests.cs` |
| 跨回合记忆 + 整回合裁剪 | `AgentRunner` | `Di.Tests/AgentLoop/AgentRunnerTests.cs` |
| 环境快照 append-on-change | `Core/AgentLoop/EnvironmentSnapshot.cs` | `Di.Tests/AgentLoop/EnvironmentSnapshotTests.cs` |
| 最终输出工具 | `AgentLoopOptions.FinalOutputTool` | `Di.Tests/AgentLoop/ReActTests.cs` |
| 工具校验缝 | `IToolValidator`（MVP 传 null） | —（预留） |
| 成本跨轮累计 | `ReAct.CombineCost` | `Di.Tests/AgentLoop/ReActTests.cs` |
| Skills 广告 + load_skill 工具注入 | `AgentRunner` | `Di.Tests/AgentLoop/AgentRunnerTests.cs` |

## 关联文档

- `docs/cli.md` —— `IAgentRunner` / `AgentResult` / 事件流的 CLI 契约视角（换语言重写时保留什么）
- `docs/modules/llm.md` —— 模型层（`IChatModel` / 重试 / 成本）
- `docs/modules/tools.md` / `docs/modules/skills.md` —— 工具与 skill 的注入 / 执行
- `docs/modules/events.md` —— 事件流与 UI 解耦
- `docs/architecture.md` —— 一次回合的完整数据流时序
