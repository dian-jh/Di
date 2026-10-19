# Core.Sessions —— 会话记录（JSONL 落盘）

> 模块文档。说明追加式审计日志、同步恢复 checkpoint、工具副作用安全边界与 `--resume`。
> 上一级入口：`docs/README.md`；落盘位置约定见 `docs/di-home.md`。

## 目的与职责

把每次 CLI 运行的轨迹**追加式落盘为 JSONL**（`~/.di/sessions/YYYY/MM/DD/session-*.jsonl`），
供重放、审计、成本统计。格式对齐 codex rollout 的会话日志约定。

## 实现原理

- **信封格式**：每条记录 `{timestamp, ordinal, type, payload}`，payload 用 snake_case。
- **记录类型**：首行 `session_meta`，之后每回合 `task_started` / `turn_context` / `response_item` /
  `task_complete`；模型调用抛异常（Repl 打印"✗ 运行失败"）的回合以 `task_failed` 收尾
  （`SessionLog.AppendFailure`），异常回合在会话文件里同样有迹可查，可复盘。
- **成本落盘**：`task_complete` 顺带记录 `cost`（`{input, output, cache_read, cache_write, total}`；
  无费率时省略）。
- **用量落盘（缓存可观测）**：`task_complete` 记录 `usage`（`input_tokens` / `output_tokens` /
  `cache_read_tokens` / `cache_write_tokens` / `cache_hit_rate` 等），供会话级聚合
  （`di --stats <file>`，见 `docs/cli.md`）。
- **会话级聚合**：`Core/Sessions/SessionStats.cs` 解析一个会话 JSONL，聚合全部 `task_complete`
  记录 → 回合数 / token 用量 / 会话级缓存命中率（Σcache_read ÷ Σ计费输入）/ 总成本 / 总耗时。
  容错：JSON 语法、结构或数值非法的记录整行跳过，不计入部分合计；聚合溢出也跳过该行。
- **追加按行 flush**：进程中断不损坏已写记录；线程安全（单锁 + 单调 `ordinal`）。
- **审计日志尽力而为，恢复日志 fail-closed**：普通 `AppendTurn` 写入失败只告警；启用 checkpoint 时，assistant 消息、工具 intent、工具结果同步写入，intent 写盘失败则拒绝执行工具。异常恢复后会重载内存轨迹；工具已 started 但无结果时拒绝同进程重试，提示先核查副作用。

## 代码入口

| 文件（相对仓库根） | 职责 |
|---|---|
| `Core/Sessions/SessionLog.cs` | 全部：`SessionLogOptions` + `SessionLog`（`StartSession` / `AppendTurn` / `AppendFailure`） |
| `Core/Sessions/SessionRecovery.cs` | 读取最新完整 checkpoint；未知工具结果拒绝恢复，未开始工具调用加入明确观察 |
| `Core/Sessions/SessionStats.cs` | 会话 JSONL 聚合：`SessionStats.Aggregate` → `SessionStatsSummary` |

## 关键符号

- `SessionLog` / `SessionLogOptions`
- `SessionLog.StartSession()`、`AppendTurn(AgentResult result, DateTimeOffset startedAt)`
- `SessionLog.AppendFailure(string userMessage, string errorMessage, DateTimeOffset startedAt)`
- `SessionStats.Aggregate(string logFilePath)` / `SessionStatsSummary`（回合数 / 用量 / 命中率 / 成本 / 耗时）
- `SessionRecovery.Load(string path)` / `SessionLog.LoadRecovery(string filePath)`：读取 checkpoint 历史；旧版日志没有 checkpoint 时明确拒绝恢复
- `AgentResult`（`Core/AgentLoop/AgentResult.cs`）—— 一次运行结局，轨迹 / 用量 / 成本 / 停止原因
- `TokenUsage.CacheHitRate`（`Core/Llm/TokenUsage.cs`）—— 每回合缓存命中率 = 命中读取 ÷ 计费输入

## 调用关系

```
Di.Cli/Repl.cs（legacy turn audit） / Core/AgentLoop/AgentRunner.cs（实时 checkpoint）
  ├─ 成功：SessionLog.AppendTurn(结果, 开始时间)
  └─ 失败（✗ 运行失败）：SessionLog.AppendFailure(用户消息, 错误信息, 开始时间)
      └─ 写 ~/.di/sessions/YYYY/MM/DD/session-*.jsonl（写入路径由 DiHome 派生）
```

## 已实现能力与测试

| 能力 | 落点 | 测试 |
|---|---|---|
| 会话 JSONL（对齐 codex 格式，snake_case 信封） | `SessionLog` | `Di.Tests/Sessions/SessionLogTests.cs` |
| 会话成本落盘（task_complete.cost，无费率省略） | `SessionLog.AppendTurn` | `Di.Tests/Sessions/SessionLogTests.cs` |
| 用量 + 命中率落盘（task_complete.usage） | `SessionLog.AppendTurn` | `Di.Tests/Sessions/SessionLogTests.cs` |
| 会话级聚合（`di --stats`：命中率 / 成本 / 耗时，容错跳过坏行） | `SessionStats` | `Di.Tests/Sessions/SessionStatsTests.cs` + `Di.Cli.Tests/cli/CliAppTests.cs` |
| 失败回合落盘（task_failed，异常回合有迹可查） | `SessionLog.AppendFailure` | `Di.Tests/Sessions/SessionLogTests.cs` + `Di.Cli.Tests/ReplTests.cs` |
| 追加按行 flush（中断不损坏）+ 线程安全 | `SessionLog` | `Di.Tests/Sessions/SessionLogTests.cs` |
| 当前轮历史快照、assistant 消息与工具执行意图逐事件写入；工具 intent 写入失败时不执行工具 | `AgentRunner` / `ReAct` checkpoint callbacks / `SessionLog` | `Di.Tests/AgentLoop/ReActTests.cs` + `Di.Tests/Sessions/SessionLogTests.cs` |
| 普通审计日志尽力而为；checkpoint 写入 fail-closed | `SessionLog` + `AgentRunner` | `Di.Tests/Sessions/SessionLogTests.cs` + `Di.Tests/AgentLoop/AgentRunnerTests.cs` |
| 只写 sessions/、不写 config.json（所有权） | `SessionLog` | `Di.Tests/Sessions/SessionLogTests.cs` |

## 关联文档

- `docs/di-home.md` —— `~/.di` 家目录结构、sessions/ 落点与所有权规则
- `docs/modules/agent-loop.md` —— `AgentResult` / `AgentStopReason` 的定义
- `docs/roadmap.md` —— 后续会话选择器与 `/resume` 命令（文件恢复 `--resume <file>` 已实现）
