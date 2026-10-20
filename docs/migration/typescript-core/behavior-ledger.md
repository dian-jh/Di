# TypeScript Core 迁移：行为台账（P0 产物）

> **状态：已冻结（P0）。** 本文件是行为清单（inventory/matrix），不是专题契约的副本；每个行为区的
> 可执行语义、红测清单与验收边界由 [execution-plan.md](execution-plan.md) 和各叶子文档唯一维护。
> **模块映射的唯一权威是 [architecture.md](architecture.md)**，本台账只引用其映射行，不再定义第二套。
>
> - 基线：Di `09f4e08`（`git cat-file -t 09f4e08` = commit）；查旧源码一律 `git show 09f4e08:<path>`，
>   不切换工作区到旧分支。
> - 参考：Pi `7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333`（`E:\Agent\PI\pi` 只读，不安装/构建/复制）。
> - 台账中所有 C# 路径均已用 `git ls-tree -r --name-only 09f4e08` 核实存在；关键符号已用
>   `git show 09f4e08:<path>` 抽查。
> - 计划 TS 测试名为叶子文档列出的**未来测试资产**，未创建；不得把本文档当作已执行证据。
> - 基线非集成测试快照（本机 Windows 11 26100，net10.0，Node 24.16.0）：
>   `dotnet test Di.slnx --no-restore --filter "Category!=Integration"` → **943 通过 / 0 失败**
>   （Di.Tests 701 + Di.Cli.Tests 242）；`npm.cmd --prefix tui test` → **116 通过 / 0 失败**；
>   `npm.cmd --prefix tui run build` → 退出码 0。详见 [progress.md](progress.md)。

## 采用 / 不采用的 Pi 边界（architecture.md §"Pi 只读参考位置"）

已按固定提交阅读 `packages/agent`（`agent-loop.ts` / `agent.ts` / `types.ts`）、`packages/ai`（providers /
auth/oauth / `openai-responses.ts` / `deepseek.ts`）、`packages/coding-agent/src/core/agent-session.ts`。

**采用（职责边界）：**
- "纯 loop + 状态 facade + coding host" 三层分离：`runAgentLoop` 纯函数、有状态 `Agent`/`AgentSession`
  宿主、host 组合根（coding-agent）。
- provider-neutral 消息/模型词汇与厂商 adapter 分层；`ChatModel.stream(request, signal)` 注入式流接口。
- 注入式 model / tool hooks / `AbortSignal`；loop 事件经 event sink 观察。
- AgentSession 作为所有模式（interactive/print/json/rpc）共用的 session turn 入口。
- Pi 的 session-manager append-only JSONL + 显式版本号 + fixture 测试做法（仅借鉴，不采用其宽容读策略）。

**不采用（Di 契约优先，见 loop-and-state.md §首期不迁移 / architecture.md）：**
- Pi 扩展系统 / plugin / package registry、sub-agent / plan mode、会话分支编辑、steering queue、
  **并行工具执行**（Di 串行）、auto compaction / 摘要、任意技能热重载。
- Pi 的消息定制机制（`CustomAgentMessages`）、`ThinkingLevel` 档位体系、`QueueMode` 队列策略。
- Pi 的 `stream-fn` / `EventStream` 具体 API 形态与 `ToolExecutionMode` 并行语义。
- Pi 的 provider catalog / SDK 依赖；Di 只迁 DeepSeek 与 ChatGPT（Responses），保留 Di wire DTO 与错误语义。
- 不引入 Pi 的 session 宽容读（跳坏行/补 LF 尾行）作为 Di 恢复策略；Di checkpoint 保持 fail-closed。

---

## P2 纯循环与宿主状态（agent loop / state）

| 项 | 内容（基线 09f4e08 已验证） |
|---|---|
| 旧 C# 源码 | `Core/AgentLoop/ReAct.cs`（`RunCoreAsync`/`RunStreamingAsync`/`EstimateRequestTokens`）、`AgentRunner.cs`（`RunAsync`/`ResetHistory`/`RestoreHistory`）、`AgentRequest.cs`、`AgentResult.cs`（`AgentStopReason`）、`AgentLoopOptions.cs`（`MaxIterations=0` 无限）、`AgentLoopEvent.cs`、`RunEvents.cs`、`IToolExecutor.cs`、`IToolValidator.cs`、`IInterruptSignal.cs`、`EnvironmentSnapshot.cs`；`Core/ContextManagement/BudgetPolicy.cs`（`Waterline`、Default* 常数）、`InputBudgetTracker.cs`、`CompactingExecutor.cs`、`ArtifactStore.cs`、`ContextManagementOptions.cs` |
| 旧 C# 测试 | `Di.Tests/AgentLoop/ReActTests.cs`、`ReActInterruptTests.cs`、`AgentRunnerTests.cs`、`EnvironmentSnapshotTests.cs`、`Fakes.cs`；`Di.Tests/ContextManagement/BudgetPolicyTests.cs`、`CompactingExecutorTests.cs`、`ArtifactStoreTests.cs`、`AgentRunnerBudgetTrimmingTests.cs`、`CompactingWiringTests.cs` |
| 目标 TS 模块（映射见 architecture.md §模块映射 / §契约表） | `@di/agent`：`packages/agent/src/agent-loop.ts`、`types.ts`、`tools.ts`、`interrupt.ts`、`events.ts`；宿主职责归 `@di/coding-agent`：`src/core/agent-session.ts`、`agent-runner.ts`、`environment-snapshot.ts`、`events.ts`、`src/core/context/` |
| 计划新测试（红测来源：loop-and-state.md §逐单元红绿实施 + execution-plan P2） | `packages/agent/test/agent-loop.test.ts`；loop phase/cancellation tests；stream/event tests（observer 异常隔离、delta 顺序）；context/iteration tests（estimate==budget/超 1/budget=0、默认无限、N 上限）；checkpoint tests（message/intent/result 写失败）；`packages/coding-agent/test/agent-session.test.ts`；history/recovery tests（整 user-turn trim、未配齐 tool calls sanitize、ContextLimit 后不 trim、unknown fail-closed）；budget/artifact tests |
| 完成门槛（execution-plan P2） | 假模型 256 次工具往返、取消、计量、事件顺序通过；纯循环测试无需磁盘、凭据和 TUI。 |

## P3 通用模型与 DeepSeek（models / providers）

| 项 | 内容（基线 09f4e08 已验证） |
|---|---|
| 旧 C# 源码 | `Core/Llm/ChatMessage.cs`（`UserMessage`/`AssistantMessage`/`SystemMessage`/`ToolResultMessage`）、`ContentBlock.cs`（`TextBlock`/`ReasoningBlock`/`ToolCallBlock`/`ImageBlock`/`FileBlock`/`OpaqueBlock`）、`ChatRole.cs`、`StreamChunk.cs`、`IChatModel.cs`（`ModelRequest`/`ModelResponse`/`ModelEvent`）、`ChatAdapter.cs`、`LlmRuntime.cs`、`ILlmService.cs`、`ChatModelClient.cs`、`ChatAssembler.cs`、`RetryingChatModel.cs`、`TokenUsage.cs`、`CostAccounting.cs`、`ModelCatalog.cs`、`LlmException.cs`、`ModelOptions.cs`、`ModelReference.cs`、`GenerateOptions.cs`、`LlmMetadata.cs`、`ChatGpt*` 中 provider 词汇外的通用部分 |
| 旧 C# 测试 | `Di.Tests/Llm/ChatModelClientTests.cs`、`RetryingChatModelTests.cs`、`TokenEstimatorTests.cs`、`TokenUsageTests.cs`、`CostAccountingTests.cs`、`ModelCatalogTests.cs`、`AuthTests.cs`；`Di.Tests/Providers/DeepSeekTranslatorTests.cs`、`DeepSeekAdapterStreamTests.cs`、`DeepSeekAuthTests.cs`、`DeepSeekServiceCollectionExtensionsTests.cs`、`DeepSeekUsageParsingTests.cs`、`ChatGptTests.cs` |
| 目标 TS 模块（映射见 architecture.md） | `@di/ai`：`packages/ai/src/types/{messages,content,stream,model}.ts`、`model.ts`、`stream-assembler.ts`、`retry.ts`、`usage.ts`、`catalog.ts`、`errors.ts`、`providers/deepseek/`、`providers/chatgpt/` |
| 计划新测试（红测来源：models-and-auth.md §红测试清单） | 消息词汇/可空字段 JSON fixture；ChatAssembler（交错 index、部分 tool args、usage-before-finish、finish 后 chunk 拒绝）；DeepSeek translator fixture（null/省略/空数组、reasoning 历史、tool choice、cache 字段）；SSE parser 边界（任意字节切分/CRLF/多行 data/注释/坏 JSON/`[DONE]`/EOF 缺终态）；ChatGPT Responses fixture（system→developer、unsupported option、failed/incomplete、raw output 回放）；retry（429/Retry-After、首事件前可重试、首事件后不重试、取消不重试） |
| 完成门槛（execution-plan P3） | 请求的稳定 system、完整 history、易变 skill 顺序以及 reasoning / 缓存字段与基线样例一致；HTTP 重试不会重放已经执行的工具。 |

## P4 八个工具与平台执行（tools & platform）

| 项 | 内容（基线 09f4e08 已验证） |
|---|---|
| 旧 C# 源码 | `Core/Tools/CoreTools.cs`（`ToolNames`：read_file/write_file/edit_file/glob/grep/bash/powershell/python，canonical 顺序）、`ICoreTool.cs`、`ReadFileTool.cs`、`WriteFileTool.cs`、`EditFileTool.cs`、`GlobTool.cs`、`GlobMatcher.cs`、`GrepTool.cs`、`BashTool.cs`、`PowerShellTool.cs`、`PythonTool.cs`、`ShellSession.cs`、`ProcessRunner.cs`（`ShellCommand`/`ProcessResult`）、`ProcessDiagnostics.cs`、`ProcessEncoding.cs`、`BoundedByteBuffer.cs`、`OutputBuffer.cs`、`ToolHelpers.cs` |
| 旧 C# 测试 | `Di.Tests/Tools/ReadFileToolTests.cs`、`WriteFileToolTests.cs`、`EditFileToolTests.cs`、`GlobToolTests.cs`、`GlobMatcherTests.cs`、`GrepToolTests.cs`、`BashToolTests.cs`、`PowerShellToolTests.cs`、`PythonToolTests.cs`、`ShellSessionTests.cs`、`ProcessRunnerTests.cs`、`EncodingTests.cs`、`BoundedByteBufferTests.cs`、`OutputBufferTests.cs`、`CoreToolsTests.cs`、`ToolHelpersTests.cs`、`TestEnvironment.cs` |
| 目标 TS 模块（映射见 architecture.md） | `@di/coding-agent`：`packages/coding-agent/src/core/tools/`（schema 与 executor 共置；Node fs/process 只从 host 进入） |
| 计划新测试（红测来源：tools-and-platform.md §红测试清单） | schema fixture 与 registry；纯文件工具（read 行号/大小/续读、write 覆盖+父目录、edit 唯一匹配/LF/BOM/原子替换中断）；Glob/Grep（* / ** / 大小写、ignore dirs、.NET→TS regex conformance matrix、literal/context/截断、超大文件、limit/60s 预算部分结果、worker terminate 可取消回溯）；ProcessRunner（超时/AbortSignal/非零退出/启动失败/头尾截断/并行 drain/进程树无遗留）；编码（OEM/GBK、非 GBK OEM capability、UTF-8 跨 chunk、截断接缝、cmd echo 剥离、Python UTF-8、PowerShell 无 BOM stdin）；ShellSession（cwd/env 跨调用、串行、随机 marker/粘连 marker、mutex、kill/重建）；Node TUI 响应性 |
| 前置预研（未完成，禁止标绿） | P4-regex-probe、P4-win-process-probe、P4-win-encoding-probe（见 progress.md；tools-and-platform.md §平台能力与未决依赖门） |
| 完成门槛（execution-plan P4） | Windows 中文 / UTF-8 混合输出、头尾截断固定内存、管道遗留、进程树超时 / 取消、shell 状态 / 自愈、扫描预算与取消、路径 / 换行均实测；不能以"返回 Promise 的同步扫描"代替异步可取消执行。 |

## P5 检查点、恢复和统计（sessions / recovery / stats）

| 项 | 内容（基线 09f4e08 已验证） |
|---|---|
| 旧 C# 源码 | `Core/Sessions/SessionLog.cs`（`SessionLogOptions` 默认 cli_version=0.1.0/originator=di/source=cli/model_provider=deepseek；`StartSession`/`AppendTurn`/`BeginCheckpointTurn`/`AppendCheckpointMessage`/`CheckpointToolStarted`/`CheckpointToolCompleted`/`CompleteCheckpointTurn`/`AppendFailure`/`LoadRecovery`）、`SessionRecovery.cs`（`Load`）、`SessionStats.cs`（`SessionStatsSummary`/`Aggregate`）；恢复语义另见 `Core/AgentLoop/AgentRunner.cs`、`Core/AgentLoop/ReAct.cs` |
| 旧 C# 测试 | `Di.Tests/Sessions/SessionLogTests.cs`（`StartSession_CreatesJsonl_WithSessionMetaFirst`、`CheckpointToolStart_IsDurableBeforeToolCanRun`、`LoadRecovery_*`、`AppendTurn_*`、`SessionId_IsUniquePerInstance` 等）、`SessionStatsTests.cs`（`Aggregate_*`）；`Di.Tests/AgentLoop/ReActTests.cs` / `AgentRunnerTests.cs` 中恢复/ContextLimit/clear 用例 |
| 目标 TS 模块（映射见 architecture.md） | `@di/coding-agent`：`packages/coding-agent/src/core/sessions/`；未来 fixture 位于 `packages/coding-agent/test/fixtures/sessions/`（未创建） |
| 计划新测试（红测来源：sessions-and-compatibility.md §测试证据与迁移 TDD 矩阵 + execution-plan P5） | fixture 驱动：`complete-tool.jsonl`（recovered）、`assistant-before-start.jsonl`（recovered_with_not_executed）、`started-no-completion.jsonl`（reject_unknown_outcome）、`legacy-audit-only.jsonl`（reject_legacy_no_checkpoint）、`torn-tail.jsonl`（recovered）、`complete-corrupt-interior.jsonl`（reject_corrupt）、`unknown-checkpoint.jsonl` / `unknown-top-level.jsonl`（reject_unknown_record）、`unknown-block.jsonl`（reject_unknown_block）、`duplicate-start.jsonl` / `orphan-result.jsonl`（reject_corrupt），配 `manifest.json`；child test host 崩溃矩阵（started 未执行 / 副作用后结果未知 / 完成结果后崩溃 / completed 写失败 / 行尾撕裂） |
| 完成门槛（execution-plan P5） | 约定兼容格式双方互读；使用真实 session store 的独立 child test host 强制终止再恢复保留结果、不由宿主重放副作用；累计快照不会重复统计，未知字段不伪造已知；P7 接线后须用真实 TS CLI 重做 crash/resume 验收。 |

## P6 Skills、配置、命令和日志

| 项 | 内容（基线 09f4e08 已验证） |
|---|---|
| **Skills** 旧 C# 源码 | `Core/Skills/SkillMarkdown.cs`、`SkillRepository.cs`、`SkillLocations.cs`、`SkillMatcher.cs`（`LexicalSkillMatcher`/`ISkillMatcher`）、`SkillActivation.cs`、`SkillContext.cs`、`SkillTools.cs`、`Skill.cs` |
| Skills 旧 C# 测试 | `Di.Tests/Skills/SkillMarkdownTests.cs`、`SkillRepositoryTests.cs`、`SkillMatcherTests.cs`、`SkillActivationTests.cs`、`SkillToolsTests.cs`、`SkillCaseLoaderTests.cs`、`SkillEvaluatorTests.cs`、`SkillDesignAuditTests.cs` |
| Skills 目标 TS 模块（映射见 architecture.md / execution-plan P6.2） | `@di/coding-agent/src/core/skills/` |
| **配置** 旧 C# 源码 | `Core/Configuration/DiHome.cs`（`Resolve`/`ConfigFile`/`SessionsDirectory`/`LogsDirectory`/`SkillsDirectory`/`CommandsDirectory`/`AgentsDirectory`）、`Di.Cli/DiConfig.cs`（`Load`）、`Di.Cli/CliHost.cs`（`Create`）、`Di.Cli/appsettings.json`（允许注释） |
| 配置旧 C# 测试 | `Di.Tests/Configuration/DiHomeTests.cs`；`Di.Cli.Tests/Configuration/DiConfigTests.cs` |
| 配置目标 TS 模块（execution-plan P6.1） | `@di/coding-agent/src/core/config/` |
| **命令 / 模型选择 / CLI 模式** 旧 C# 源码 | `Di.Cli/Commands/SlashCommandRegistry.cs`、`BuiltinCommands.cs`、`CommandLoader.cs`、`CommandMarkdown.cs`、`SlashCommand.cs`、`CommandResult.cs`、`CommandContext.cs`；`Di.Cli/ModelSelection.cs`；`Di.Cli/cli/CliArgs.cs`（`CliArgs`/`CliArgsParser`）、`CliMode.cs`、`CliInfo.cs`；`Di.Cli/CliApp.cs`、`Program.cs`、`Repl.cs`、`ReplOptions.cs`、`InterruptCoordinator.cs`、`ILineReader.cs`、`EventRenderer.cs` |
| 命令 / 模型选择旧 C# 测试 | `Di.Cli.Tests/Commands/{SlashCommandRegistry,BuiltinCommands,CommandLoader,CommandMarkdown}Tests.cs`；`Di.Cli.Tests/ModelSelectionTests.cs`；`Di.Cli.Tests/cli/{CliArgsTests,CliModeTests,CliAppTests}.cs`；`Di.Cli.Tests/{ReplTests,EventRendererTests,InterruptCoordinatorTests,TuiLauncherTests}.cs` |
| 命令 / 模型选择目标 TS 模块（execution-plan P6.3） | `@di/coding-agent/src/core/commands/`、`src/core/model-selection.ts`、`src/cli/`、`src/modes/` |
| **日志** 旧 C# 源码 | `Core/Logging/DiLog.cs`（`Subscribe`/`Log`/`Dispose`）、`DiLogOptions.cs`、`Core/Tools/ProcessDiagnostics.cs` |
| 日志旧 C# 测试 | `Di.Tests/Logging/DiLogTests.cs` |
| 日志目标 TS 模块（execution-plan P6.4） | `@di/coding-agent/src/core/logging/` |
| 计划新测试（红测来源：execution-plan P6.1–P6.4） | 配置：DI_HOME 空白回退/不同根/相对绝对路径、默认→用户→项目→环境优先级逐键合并、`__` 层级键/大小写/未知键/数字布尔空值、JSONC 解析固定版本、sessions/logs/artifacts/auth 权限、任意 CWD 资源定位、`--info` 如实报告。Skills：frontmatter 重复键拒绝/未知字段忽略/名称一致/BOM/CRLF、来源顺序、同源冲突、ASCII 分词/中文二元组/阈值 0.30/最多 3 个/Ordinal 排序、pinned 在前/auto 去重、disclosure 分离、allowed-tools 不作权限宣称。命令：内置 8 命令、用户命令 Markdown、注册表帮助/补全、RPC turn_not_supported/turn_message。模型选择：唯一 ID/唯一片段/歧义/刷新失败保留快照/忙碌拒绝。CLI：`--`/别名/缺值/未知旗标/TTY/stdin/version/info/help/list-models/stats/skill-eval/auth chatgpt、`CliMode.Resolve` 优先级、`--resume` 简单交互。日志：本地时区/按日轮转/字段折叠截断/生命周期一事件一行/逐字流不写日志/慢进程诊断/退出关闭 |
| 完成门槛（execution-plan P6） | 同 fixture 下生效配置相同且加载不要求凭据；`--info` 如实报告实际入口/来源/默认不限轮数；相同消息在 REPL/print/JSON/RPC 激活集一致；固定激活与一次性带参数执行都保留。 |

## P7 TS 宿主 / RPC / 现有 TUI

| 项 | 内容（基线 09f4e08 已验证） |
|---|---|
| 旧 C# 源码 | `Di.Cli/modes/RpcMode.cs`（`EventPayload`/`ResultPayload`）、`Di.Cli/modes/PrintMode.cs`、`Di.Cli/CliHost.cs`、`Di.Cli/TuiLauncher.cs`；既有 TUI：`tui/src/rpc/{protocol,codec,client}.ts`、`tui/src/main.ts`、`tui/src/app/*`（state/chat-view/commands 等 15 个 TS 生产文件） |
| 旧 C# 测试 | `Di.Cli.Tests/modes/RpcModeTests.cs`、`PrintModeTests.cs`、`TuiLauncherTests.cs`；既有 TUI 测试 116 项（tui 测试目录） |
| 目标 TS 模块（映射见 architecture.md §Runner seam） | `@di/coding-agent/src/modes/{print,json,rpc}/`；`tui/src/runner/port.ts`、`tui/src/interactive.ts`、`tui/src/index.ts`；`packages/coding-agent/src/adapters/tui-runner.ts`（`LocalAgentRunnerAdapter`） |
| 计划新测试（红测来源：loop-and-state.md runner seam/RPC contract tests + architecture.md） | subscribe-before-connect、ready 恰好一次且先于 connect resolve、prompt 单次 result callback、hard interrupt/cancelled、clear history、set model/skills、list/run command、ping、stop、旧 wire fixtures、busy prompt 后仍可处理 interrupt、未知事件兼容、TUI 原测试不退化 |
| 完成门槛（execution-plan P7） | TUI 原测试继续通过，相同合成任务在两后端有同等可观察行为，启动 / 取消 / 模型故障可诊断；另以真实 TS CLI 重跑 P5 的 completed 后 kill/restart 与未知结果拒绝场景。 |

## P8 ChatGPT 认证与凭据（auth / responses）

| 项 | 内容（基线 09f4e08 已验证） |
|---|---|
| 旧 C# 源码 | `Core/Providers/ChatGpt/ChatGptAuth.cs`、`ChatGptCredentialStore.cs`（`Credential`/`NeedsRefresh`（提前 3 分钟）/`ClearTokens`/`HostId`/`FromToken`）、`ChatGptAdapter.cs`、`ChatGptTranslator.cs`、`Di.Cli/ChatGptAuthCommand.cs` |
| 旧 C# 测试 | `Di.Tests/Providers/ChatGptTests.cs`（`CacheAffinity_UsesStableOpaqueSessionKey`/`UnsupportedSampling_IsRejectedLocally` 等）、`Di.Tests/Llm/AuthTests.cs` |
| 目标 TS 模块（映射见 architecture.md） | provider wire：`@di/ai/src/providers/chatgpt/`；凭据存取 / OAuth / 刷新：`@di/coding-agent/src/core/auth/` |
| 计划新测试（红测来源：models-and-auth.md §红测试清单 / §OAuth PKCE） | OAuth state/PKCE/path/client id/scope/token 字段校验，拒绝坏响应旧凭据不变；expiry 3 分钟边界；轮换令牌并发竞争只刷新一次；原子替换中断/临时文件清理/Unix mode/Windows ACL adapter/多进程更新无丢失/过期锁回收不误删活锁/日志脱敏 |
| 前置预研（未完成，禁止标绿） | P8-auth-storage-probe（见 progress.md；models-and-auth.md §依赖决策门） |
| 完成门槛（execution-plan P8） | 合成端点下认证 / 并发刷新 / 失败路径通过；两 provider 切换、较小窗口、缺凭据 / 无网络不会破坏状态；未做真实账号 smoke 必须如实记录。 |

## P9 本地 Runner、切换与发布验收

| 项 | 内容 |
|---|---|
| 涉及源码 | 由 [validation-and-release.md](validation-and-release.md) 定义；production CLI `@di/coding-agent/dist/cli/main.js`（`di-ts`），local adapter 接线，安装 / 切换 / 回退 |
| 完成门槛（execution-plan P9 / validation-and-release.md） | 干净安装、契约差分、关键故障恢复、原 TUI 保持、文档权威切到 TS、回退均通过；10 小时真实墙钟 soak（每受支持 OS 至少一次）；C# reference 双向互通（Di writer→TS reader、TS writer→C# `SessionLog.LoadRecovery` harness、负例）；Windows/macOS/Linux × Node 22.19/24 平台矩阵；隔离 tarball 安装验证 |
