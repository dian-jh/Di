# Core.Sessions —— 会话记录（JSONL 落盘）

> 模块文档。回答"会话如何落盘、格式是什么、写盘失败会不会打断聊天"。
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
- **追加按行 flush**：进程中断不损坏已写记录；线程安全（单锁 + 单调 `ordinal`）。
- **尽力而为**：磁盘错误只告警，绝不打断聊天。

## 代码入口

| 文件（相对仓库根） | 职责 |
|---|---|
| `Core/Sessions/SessionLog.cs` | 全部：`SessionLogOptions` + `SessionLog`（`StartSession` / `AppendTurn` / `AppendFailure`） |

## 关键符号

- `SessionLog` / `SessionLogOptions`
- `SessionLog.StartSession()`、`AppendTurn(AgentResult result, DateTimeOffset startedAt)`
- `SessionLog.AppendFailure(string userMessage, string errorMessage, DateTimeOffset startedAt)`
- `AgentResult`（`Core/AgentLoop/AgentResult.cs`）—— 一次运行结局，轨迹 / 用量 / 成本 / 停止原因

## 调用关系

```
Di.Cli/Repl.cs（每回合结束）
  ├─ 成功：SessionLog.AppendTurn(结果, 开始时间)
  └─ 失败（✗ 运行失败）：SessionLog.AppendFailure(用户消息, 错误信息, 开始时间)
      └─ 写 ~/.di/sessions/YYYY/MM/DD/session-*.jsonl（写入路径由 DiHome 派生）
```

## 已实现能力与测试

| 能力 | 落点 | 测试 |
|---|---|---|
| 会话 JSONL（对齐 codex 格式，snake_case 信封） | `SessionLog` | `Di.Tests/Sessions/SessionLogTests.cs` |
| 会话成本落盘（task_complete.cost，无费率省略） | `SessionLog.AppendTurn` | `Di.Tests/Sessions/SessionLogTests.cs` |
| 失败回合落盘（task_failed，异常回合有迹可查） | `SessionLog.AppendFailure` | `Di.Tests/Sessions/SessionLogTests.cs` + `Di.Cli.Tests/ReplTests.cs` |
| 追加按行 flush（中断不损坏）+ 线程安全 | `SessionLog` | `Di.Tests/Sessions/SessionLogTests.cs` |
| 尽力而为（磁盘错误只告警） | `SessionLog` 调用方（`Di.Cli/Repl.cs`） | `Di.Tests/Sessions/SessionLogTests.cs` |
| 只写 sessions/、不写 config.json（所有权） | `SessionLog` | `Di.Tests/Sessions/SessionLogTests.cs` |

## 关联文档

- `docs/di-home.md` —— `~/.di` 家目录结构、sessions/ 落点与所有权规则
- `docs/modules/agent-loop.md` —— `AgentResult` / `AgentStopReason` 的定义
- `docs/roadmap.md` —— `/resume` 会话恢复（路线图 Phase C）
