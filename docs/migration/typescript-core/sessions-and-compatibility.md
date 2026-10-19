# 会话持久化、恢复与兼容契约（迁移目标）

> 状态：迁移蓝图；目标 TypeScript 文件、命令和测试尚未创建。本文描述 Di 基线 `09f4e0816c1b2dc42461e79a968b46e811d3880c`，不宣称 TypeScript 实现已具备这些能力。迁移架构及包边界见 [`architecture.md`](architecture.md)；执行阶段与总 gate 见 [`execution-plan.md`](execution-plan.md)。

## 目标与兼容边界

迁移后的 `@di/coding-agent` 宿主负责 session 文件、恢复入口和 `packages/coding-agent/src/core/sessions/`。`@di/agent` 只负责 loop 回调和恢复后的消息历史，不拥有磁盘格式；保留的 `tui/` 通过现有 RPC host 协议工作。该目标路径尚未创建，统一架构见 [`architecture.md`](architecture.md)。

兼容基线为 Di `09f4e08` 的 JSONL 记录和 checkpoint 子集。普通审计记录可继续用于审计/统计，但只有包含可识别 checkpoint 的文件允许 `--resume`。旧版本没有 checkpoint 的文件必须给出明确拒绝；不得尝试从审计 `response_item` 猜测可恢复状态。

Pi 只读参考固定在 `7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333`。其 [`session-manager.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/src/core/session-manager.ts) 定义 versioned session header 和带 `id`/`parentId` 的 append-only JSONL entry tree；版本迁移见 `migrateSessionEntries`，文件恢复/解析见 `loadEntriesFromFile` 与 `parseSessionEntryLine`。对应 [`load-entries.test.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/test/session-manager/load-entries.test.ts) 覆盖坏行跳过、有效未换行尾记录补 LF、无效非 session 文件不修改及版本迁移；[`file-operations.test.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/test/session-manager/file-operations.test.ts) 覆盖 append 保留旧内容及拒绝覆盖非空无效文件。Pi 的宽容读/尾行修复服务于它自己的 session tree，Di 的 started/completed checkpoint 含副作用执行证据，不能照搬“跳坏行后继续”策略。本文只借鉴固定提交中可见的 append-only、显式格式版本与 fixture 测试做法；没有据此引入 Pi 的分支/compaction 等 feature。

首期跨语言兼容是发布门槛：TS 必须读取 Di `09f4e08` 已知 checkpoint 子集，并写出该同一子集，使固定 C# reference 能读取；通过双向互读 fixture 和 C# reader 验收后才能发布。普通 C# 审计事件能否由 TS 统计，与能否恢复分开验收。`cli_version` 不是 schema version，首期不增加新 record/block/schema；未来 schema 扩展不属于首期承诺。未知 checkpoint record 或 block 一律拒绝恢复并报告行号/type，不得跳过，因为该记录可能是工具完成凭据，跳过会把执行状态误判。普通 audit-only 文件可由独立统计器尽力跳过未知审计记录。

## Di 文件布局与逐行 envelope

写入根目录由 `DI_HOME`/`DiHome` 解析，缺省为用户 `.di`；session 文件路径为 `~/.di/sessions/YYYY/MM/DD/session-YYYY-MM-DDTHH-mm-ss-{sessionId前8位}.jsonl`。目录和文件名日期时间来自 `DateTimeOffset.UtcNow`，不是本地时区；迁移时统一 UTC 并以 fixture 锁定格式，避免 JS locale 影响。每行 UTF-8 JSON，末尾 LF，无 BOM；顶层属性顺序由当前匿名对象序列化器稳定输出为：

```json
{"timestamp":"2026-10-19T03:04:05.006Z","ordinal":0,"type":"session_meta","payload":{"session_id":"0123456789abcdef0123456789abcdef","id":"0123456789abcdef0123456789abcdef","timestamp":"2026-10-19T03:04:05.006Z","cwd":"C:\\work\\demo","originator":"di","cli_version":"0.1.0","source":"cli","thread_source":"user","model_provider":"deepseek"}}
```

Envelope 字段为 `timestamp`（UTC 毫秒、`Z`）、`ordinal`（从 0 起单调递增）、`type`、`payload`。对象字段顺序不是 JSON 语义所必需，但为既有消费者及 snapshot 方便，应在 writer 中固定上述顺序。null 属性被省略，payload 字段 snake_case，非 ASCII 以 UTF-8 原样写出。`session_meta` 必须是第一条。实际 writer 目前设置 `SessionLogOptions.CliVersion` 默认 `0.1.0`、`Originator=di`、`Source=cli`、`ModelProvider=deepseek`。

### 审计型回合（非恢复凭据）

旧审计路径为 `session_meta`，每轮依序 `event_msg(task_started)`、`turn_context`、若干 `response_item`、`event_msg(task_complete)`；失败轮以 `event_msg(task_failed)` 结束。`task_started.payload` 含 `type,turn_id,started_at`；`turn_context.payload` 含 `turn_id,cwd`。常见 `response_item` 类型为 `message`（`role`、`content:[{type:input_text|output_text,text}]`）、`reasoning`（`summary:[{type:summary_text,text}]`）、`function_call`（`name,arguments,call_id`）、`function_call_output`（`call_id,output`）。`task_complete` 含 `turn_id,last_agent_message,stop_reason,iterations,completed_at,duration_ms`，可带 `cost:{input,output,cache_read,cache_write,total}` 与 `usage:{input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cache_hit_rate,...}`。统计用例应覆盖这些可选字段和省略 null 行为。注意：`AppendTurn` 是整轮审计写入，不是实时 checkpoint，不能拿它恢复崩溃在工具调用中途的状态。

### 实时 checkpoint record 与完整示例

checkpoint writer 当前按以下顺序逐条 append JSONL 记录：

1. `checkpoint_turn_started`：`payload.started_at`（Unix ms）、`history`（本轮开始时已有消息快照）、`user`（当前用户消息）。
2. 每个模型响应先 `trajectory_checkpoint` 一条完整 assistant 消息（含 text/reasoning/tool_call block）。这是 intent 的来源记录。
3. 每个工具执行前写 `checkpoint_tool_started`，包含 `call_id,name,arguments`。写入失败必须中止工具执行。
4. 工具完成后写 `checkpoint_tool_completed`，包含相同 `call_id` 和完整 `message`（role tool、`call_id,text,is_error`）。只有此记录持久化后才可把结果作为完成事实恢复。
5. 新一轮模型响应又从 assistant trajectory 开始；轮次正常结束后 `checkpoint_turn_completed` 记录 `stop_reason,iterations`。每个 `checkpoint_turn_started` 都携带当时 runner 的完整 `history` 快照和当前 user；恢复时以最后一个快照为基底，再追加之后持久化的增量。快照中已有的历史（即使来自此前轮次）仍会恢复。`/clear` 后则由空 history 快照明确截断旧对话。

以下 JSONL 是字段/序列示例，时间与 ID 是说明值；真实生产时间及 call id 每次生成：

```jsonl
{"timestamp":"2026-10-19T03:04:05.006Z","ordinal":0,"type":"session_meta","payload":{"session_id":"0123456789abcdef0123456789abcdef","id":"0123456789abcdef0123456789abcdef","timestamp":"2026-10-19T03:04:05.006Z","cwd":"C:\\work\\demo","originator":"di","cli_version":"0.1.0","source":"cli","thread_source":"user","model_provider":"deepseek"}}
{"timestamp":"2026-10-19T03:04:05.010Z","ordinal":1,"type":"checkpoint_turn_started","payload":{"started_at":1792379045000,"history":[],"user":{"role":"user","blocks":[{"type":"text","text":"检查并修复构建"}]}}}
{"timestamp":"2026-10-19T03:04:06.100Z","ordinal":2,"type":"trajectory_checkpoint","payload":{"message":{"role":"assistant","blocks":[{"type":"reasoning","text":"先检查构建输出"},{"type":"tool_call","id":"call-01","name":"read_file","arguments":"{\"path\":\"build.log\"}"}]}}}
{"timestamp":"2026-10-19T03:04:06.110Z","ordinal":3,"type":"checkpoint_tool_started","payload":{"call_id":"call-01","name":"read_file","arguments":"{\"path\":\"build.log\"}"}}
{"timestamp":"2026-10-19T03:04:06.180Z","ordinal":4,"type":"checkpoint_tool_completed","payload":{"call_id":"call-01","message":{"role":"tool","call_id":"call-01","text":"error CS1002","is_error":false}}}
{"timestamp":"2026-10-19T03:04:06.500Z","ordinal":5,"type":"trajectory_checkpoint","payload":{"message":{"role":"assistant","blocks":[{"type":"text","text":"缺少分号"}]}}}
{"timestamp":"2026-10-19T03:04:06.501Z","ordinal":6,"type":"checkpoint_turn_completed","payload":{"stop_reason":"Answer","iterations":2}}
```

checkpoint message 的 block 白名单为 `text{text}`、`reasoning{text}`、`tool_call{id,name,arguments}`、`image{attachment_id,detail?}`、`file{attachment_id,filename?}`、`opaque{unknown_type,raw_json}`。system 消息是 `{role:"system",text}`；user/assistant 是 `{role,blocks}`；tool result 是 `{role:"tool",call_id,text,is_error}`。`arguments` 与 opaque raw payload 是字符串，迁移不能擅自 parse+reserialize，否则会改动模型原始参数文本。Di 当前 writer 对未知 block 会写 `{type:"unknown",value:...}`，reader 则拒绝未知 block；这条写读不对称不能复制，TS writer 必须拒绝无法序列化的 block。未知 block/record 的向前兼容策略需新 schema/version 设计后再扩展。

## 原子性、恢复状态机与错误处理

单行记录是恢复提交单元：writer 先序列化一条记录，再 append 并关闭本次写入；这不等于 OS、存储设备或掉电层面的原子/持久性保证，也不是多行事务。进程被杀或掉电可能留下无 LF 的 partial tail；恢复只丢弃这一条未完整尾行，完整 LF 行中的损坏则拒绝。工具调用必须维持 `assistant intent -> started -> execute -> completed` 次序，具体 `call_id` 与原始 arguments 必须逐字保留。若进程在 started 之后、completed 之前崩溃，工具可能已产生副作用，恢复必须 fail closed，列出 call id/name 并要求检查副作用；禁止自动重放或补成功结果。尚未写 started 的 assistant tool call 可用合成 `tool` observation 明确标注“not executed before checkpoint”，模型之后可重新判断是否仍需调用。completed 缺少 started、孤立 started、重复 started/completed、call_id 不匹配、同一 assistant batch 重复 call id、孤立 tool result 均为损坏并拒绝。相同 call id 在不同 assistant batch 允许出现，不能全文件全局去重。

恢复时只接受完整 LF 结尾记录。无 LF 的最后字节视为 torn append，整行忽略；若文件没有任何完整记录则报无有效 checkpoint。完整行中任何 JSON 错误、缺字段、类型错误、未知 checkpoint 类型或内部坏行都拒绝，并带行号；不可把“坏行当空白跳过”。空白行策略应在 fixtures 中固定（当前 `RemoveEmptyEntries` 会忽略空行）。恢复只重建最后一个 `checkpoint_turn_started` 起的轨迹：其 `history` + `user`，之后按序追加完整消息和结果。遇到新 turn start 时若仍有未决 started，应拒绝。没有任何 checkpoint 的 legacy session 明确拒绝，错误应说明旧审计文件不含可恢复 checkpoint。

同进程恢复也是正式行为：模型错误、普通工具错误 observation、硬取消、checkpoint 写入失败各走其真实路径。`ExecuteToolAsync` 将普通工具异常转为 `is_error=true` 的 observation；随后仍追加 `checkpoint_tool_completed`，此结果可安全恢复，不锁住 runner。`OperationCanceledException` 在 cancellation token 已取消时向外抛出，不会生成 completed；其他情况下若 started 已写但 completed 缺失（例如进程中断、结果 checkpoint 写失败），结果未知，host 必须锁住继续请求直到显式 `/clear`/reset。模型调用失败但已完成工具都具有 completed 时，可重新载入历史并同进程继续，不能重复执行工具。`/clear` 清空 runner 历史；下一次 `checkpoint_turn_started` 写空 history，因此恢复不得复活 clear 之前轮次。遇到 `ContextLimit` 时保留完整当前任务和已完成工具结果作为暂停状态；扩充预算后可显式继续，不能修剪掉原始任务或伪报成功。`--resume <file>` 创建新宿主/runner 并载入历史；默认模式推导、显式 `--mode`、`--print` 和 positionals 仍遵循 `CliMode.Resolve` 优先级，所以它不总是进入 REPL。`--resume` 不回连旧进程，也不得自动再跑未完成工具。CLI 参数解析失败、旧日志、损坏文件须在调用模型前退出并展示可诊断错误。

**源码缺口/迁移修正项：**当前 `SessionRecovery.Load` 对未知顶层 record type 没有 `default` 分支，会静默忽略；未知 checkpoint record 可能是状态证据，因此 TS 必须拒绝。当前 `ReadMessage` 的字段获取大多直接 `GetProperty`，会抛低层异常，迁移应把它们规范化为包含行号的 `InvalidData` 类错误。当前 append 每行 `File.AppendAllText` 不提供跨进程文件锁，单进程 `_lock` 只保证进程内顺序；首期明确一个 session 文件只有单 writer，不承诺多进程并写。禁止让这些实现细节成为“必须兼容”的坏行为。

## 测试证据与迁移 TDD 矩阵

以下是 Di `09f4e08` 现有具体测试，不是要求 TS 按测试数量复制。先将最小语言中立 JSONL fixtures 提取到**未来路径** `packages/coding-agent/test/fixtures/sessions/`（尚未创建），覆盖：审计成功轮、checkpoint 完整工具轮、assistant-only 前缀、started-only 不确定前缀、completed、torn tail、interior corruption、legacy no checkpoint、unknown record/block。每个红绿单元先新增 `node:test` 测试，再实现，执行 `npm test --workspace @di/coding-agent`（命令为未来 package script 草案，当前不存在）。

| 需求 | Di 当前证据（路径::方法） | TypeScript 首期测试/红绿断言 |
|---|---|---|
| envelope、session_meta 首行、默认字段、UTF-8、ordinal 顺序、审计序列 | `Di.Tests/Sessions/SessionLogTests.cs::StartSession_CreatesJsonl_WithSessionMetaFirst`、`AppendTurn_WritesFullTurnSequence`、`AppendTurn_OrdinalsMonotonicAcrossTurns`、`AppendTurn_ChineseContent_WrittenAsUtf8` | 对照字节/逐行 fixture；精确断言关键字段和顺序，不只断言 parse 成功 |
| usage/cost 及 null 省略 | 同文件 `AppendTurn_TaskComplete_IncludesCost`、`AppendTurn_NoCost_OmitsCostField`、`AppendTurn_TaskComplete_IncludesUsageAndCacheHitRate`；聚合见 `Di.Tests/Sessions/SessionStatsTests.cs::Aggregate_RealSessionLog_SumsUsageAndCost_ComputesHitRate` | fixture round-trip；小数精度、null key 省略、统计完整不部分累计 |
| 工具开始先落盘、结果闭合 intent | `Di.Tests/Sessions/SessionLogTests.cs::CheckpointToolStart_IsDurableBeforeToolCanRun`、`LoadRecovery_EachToolCheckpointPrefixIsSafe`；`Di.Tests/AgentLoop/ReActTests.cs::RunAsync_CheckpointFailureBeforeTool_PreventsToolExecution` | spy executor 检查调用前文件已有 started；注入 writer 故障时 executor 次数为 0；started-only 必须给 unknown，不能调用 executor |
| 已完成工具恢复、请求历史顺序、256 个调用完整 | `Di.Tests/AgentLoop/AgentRunnerTests.cs::LongToolRun_CheckpointsAndRecoversEveryResultInOrder`、`Checkpoints_RestoreCompletedToolWhenLaterModelCallFails` | faux model 脚本 + fake executor，比较 call id、arguments、结果顺序；长度规模可用合理样本，强调不丢/不重/不乱序，不要求机械复制 256 |
| 普通工具异常成为已完成 error observation | `Di.Tests/AgentLoop/ReActTests.cs::RunAsync_ToolExecutionThrows_TurnsIntoErrorObservationAndContinues` | executor 普通异常转 `is_error=true`，仍写 completed 并可恢复；同 runner 可继续 |
| 同进程模型失败后恢复且不重复工具 / 未知结果锁定 | `Di.Tests/AgentLoop/AgentRunnerTests.cs::FailedModelCall_RefreshesInMemoryHistoryBeforeSameRunnerContinues`、`UnknownToolOutcome_BlocksInProcessRetryUntilHistoryReset`；取消路径见 `Di.Tests/AgentLoop/ReActTests.cs` checkpoint/cancellation tests | completed 已落盘后模型失败，同 runner 继续且 executor 只一次。取消 token 已取消且 started 后无 completed，或完成记录写入失败，应视为 unknown 并 block；普通工具异常本身不应锁定 |
| 未开始 intent 的明确观察、batch 内外 id 规则、损坏状态 | `Di.Tests/Sessions/SessionLogTests.cs::LoadRecovery_ProvidesExplicitObservationForToolThatNeverStarted`、`LoadRecovery_HandlesSameCallIdInSeparateAssistantBatches`、`LoadRecovery_RejectsOrphanToolStartRecord`；`LoadRecovery_RejectsToolWithStartedMarkerButNoOutcome` | 正常化时间/随机 session/turn id 后对比，保留 call id、原始 arguments、name 与记录 ordering；同 batch duplicate 拒绝、跨 batch 可重复 |
| torn tail 与坏 interior、legacy 明确拒绝 | `Di.Tests/Sessions/SessionLogTests.cs::LoadRecovery_IgnoresOnlyTornFinalLineAndRejectsCorruptInteriorLine`、`LoadRecovery_RejectsLegacyLogWithoutCheckpoints` | 分别构造无换行破尾与有 LF 的坏行；前者只忽略最后不完整行，后者拒绝；纯旧审计文件明确 unsupported |
| clear 与 checkpoint 基点 | `Di.Tests/AgentLoop/AgentRunnerTests.cs::ResetHistory_NextRecoveryCheckpointDoesNotReviveClearedTurns`；REPL 入口 `Di.Cli.Tests/ReplTests.cs::ClearCommand_ResetsConversationMemory` | 两轮后 clear 再写新轮，reload 只含新任务；另外断言 UI 的 clear RPC/command 不要求删除历史文件 |
| ContextLimit 保留任务/工具结果 | `Di.Tests/AgentLoop/AgentRunnerTests.cs::ContextLimit_PreservesRestoredTaskAndToolResultUntilLargerBudgetContinues`、`ContextLimit_PreservesOversizedCurrentTaskWithoutCallingModel`；`Di.Tests/AgentLoop/ReActTests.cs::RunAsync_ContextBudgetExceededBeforeModelCall_ReturnsContextLimit` | faux model 断言超限前无请求，恢复任务和 tool result 保留，扩大预算后继续请求仍带必要原任务/工具结果 |
| `--resume` 新宿主和旧文件错误入口 | `Di.Cli.Tests/cli/CliArgsTests.cs::Parse_ResumePath_EntersInteractiveMode`、`Di.Cli.Tests/cli/CliAppTests.cs::Resume_UsesReplWithoutTryingTui`、`ResumeHostFailure_UsesJsonErrorEnvelopeInJsonMode` | CLI 层测试新 runner 初始化、恢复消息载入、错误发生在模型调用前；保留现有 RPC/TUI 交互边界 |

快照：用户提供的验收记录为 943 项 .NET 非集成测试和 116 项 TUI 测试；这只是某次基线快照，不是未来 TS 的固定数量门槛，也不能以数量相等替代行为覆盖。不要调用真实商业模型做单测。更高层验证可开本机 fake SSE HTTP server，按固定 stream chunk/usage/error 返回并记录 request body；覆盖 adapter 到 session checkpoint 的真实本地 HTTP 路径。进程崩溃测试使用 child process + 临时 `DI_HOME`，由 fixture tool 写入外部 marker 后在 started/completed 两个边界通过测试专用 failpoint 强制终止。marker 存在且日志无 completed 时，reload 必须 fail closed 且不再次执行；这比只在内存抛异常更能验证 crash window。所有 failpoint 仅为未来测试工具，不加入产品行为。模型请求对比需规范化时间、随机 session/turn id；必须保留和比较 tool call id、name、arguments 字符串及消息/记录顺序。

CI、Node/npm pinning、P0–P9 阶段 gate、发布证据、隔离安装及回退步骤统一见 [`validation-and-release.md`](validation-and-release.md) 与 [`execution-plan.md`](execution-plan.md)。本节不重复维护第二份 CI/发布方案。协议阶段为 P5；工具链和后续宿主阶段按 execution plan 安排。基线审查使用固定 Di SHA 的 `git show`/只读 worktree，不以可变工作分支代替。

## 文件内核实来源

- session writer/parser：`Core/Sessions/SessionLog.cs`、`Core/Sessions/SessionRecovery.cs`、`Core/Sessions/SessionStats.cs`
- loop callbacks/recovery/context limit：`Core/AgentLoop/AgentRunner.cs`、`Core/AgentLoop/ReAct.cs`
- 具体测试文件/方法列于上表。
- 相关现行契约：[`docs/modules/sessions.md`](../../modules/sessions.md)、[`docs/context-compression.md`](../../context-compression.md)、[`docs/tui-rpc.md`](../../tui-rpc.md)、[`docs/di-home.md`](../../di-home.md)。
