# TypeScript Core 迁移：进度表

> **状态：P0–P2.3 各单元、P3.1–P3.3、P4.1 与 P6.1 已完成；P2.4 派发中、P3.4 / P4.2 运行中（本文件由 P0 提交创建，各迁移单元更新）。** 只保存简短状态表与证据位置，不复制专题契约；
> 契约见 execution-plan.md / 各叶子文档。状态只用 `todo` / `in_progress` / `blocked` / `verified`。
> 预研四项发现已提交（27e3e60），状态 `verified`：选型结论与最终发布验收仍需独立复核。

## 基线快照（P0 建立时）

- 分支 `migration/typescript-core`；P0 前 HEAD `4b16e614769f4a88a028717240abc102a3ca8559`；工作区 clean。
- 行为基线提交 `09f4e08`（`git cat-file -t 09f4e08` → `commit`）；旧源码只经 `git show 09f4e08:<path>` 读取。
- Pi 只读参考 `E:\Agent\PI\pi` @ `7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333`（`git -C E:\Agent\PI\pi rev-parse HEAD` 核实）；未安装 / 构建 / 复制。
- 平台：Windows 11 Enterprise 26100；Node `v24.16.0`；npm `11.13.0`；dotnet `10.0.301`。
- 锁定版本（来自 `tui/package-lock.json`，P0 已核实）：TypeScript `5.9.3`、`@types/node` `22.20.5`、`@earendil-works/pi-tui` `1.2.0`；最低 Node 沿用 `>=22.19`。

## 基线非集成测试证据（P0）

隔离临时 `DI_HOME=/tmp/di-p0-baseline`（不读取真实凭据）：

| 命令 | 退出码 | 结果 |
|---|---|---|
| `dotnet test Di.slnx --no-restore --filter "Category!=Integration" --verbosity minimal` | 0 | **943 通过 / 0 失败 / 0 跳过**（Di.Tests 701 + Di.Cli.Tests 242，net10.0）；`--no-restore` 直接可用（assets 已存在），无需回退 restore |
| `npm.cmd --prefix tui test` | 0 | **116 通过 / 0 失败**（suites 31, duration ~5.1s） |
| `npm.cmd --prefix tui run build` | 0 | `tsc` 构建成功 |

已知环境信息：xUnit1031 静态警告（"Test methods should not use blocking task operations"）出现在多个 `Di.Tests/Tools/*` 测试文件，仅警告不影响结果。未运行任何真实 API 集成测试（`Category=Integration` 已过滤）。

## 任务状态表

| 任务 ID | 依赖 | 状态 | 实现提交 | 验证命令 / 退出码 | 阻塞点 |
|---|---|---|---|---|---|
| P0 冻结参考与行为清单 | 无 | **verified** | 本提交（创建本文件与 behavior-ledger.md；hash 见交接报告 / `git log -1`） | 见上表三行，退出码均 0 | 无 |
| P1 最小工作区、词汇和夹具 | P0 | **verified** | P1.1（见子行）+ P1.2（a8144ea、731f8b5） | 见 P1.1 / P1.2 子行 | 无 |
| P1.1 根 workspace、@di/ai 词汇与假模型无工具答案红→绿 | P0 | **verified** | 见本单元交接（`git log -1`） | `npm install`(0)；红测 `npm test -w @di/ai`(1, ERR_MODULE_NOT_FOUND)；绿测 `npm test -w @di/ai`(0, 1 pass)；`npm run build`(0)；`npm run typecheck`(0)；`npm.cmd --prefix tui test`(0, 116 pass)；`npm.cmd --prefix tui run build`(0) | 无 |
| P1.2 记录型假执行器与跨语言 fixtures | P1.1 | **verified** | a8144ea、731f8b5 | 红：`npm run typecheck -w @di/agent`(2, TS2305 导出缺失)；`npm test -w @di/agent`(1, fixtures ENOENT)。绿：`npm run typecheck -w @di/agent`(0)、`npm run build -w @di/agent`(0)、`npm test -w @di/agent`(0, 8 pass)、根 `npm run typecheck`(0)、`npm.cmd --prefix tui test`(0, 116 pass)、`npm.cmd --prefix tui run build`(0) | 无 |
| P2 纯循环与宿主状态 | P1 | in_progress | P2.1、P2.2、P2.3（见子行）；P2.4 待派 | 见 P2.1 / P2.2 / P2.3 子行 | 无 |
| P2.1 无工具答案路径与消息良构 | P1.2 | **verified** | 见 P2.1 交接 | 红：`npm test -w @di/agent`(1, 缺 runAgentLoop 导出)、`npm run typecheck -w @di/agent`(2, TS2305)。绿：`npm run build -w @di/agent`(0)、`npm test -w @di/agent`(0, 18 pass)、`npm run typecheck -w @di/agent`(0)、根 `npm run typecheck`(0)、`npm.cmd --prefix tui test`(0, 116 pass)、`npm.cmd --prefix tui run build`(0) | 无 |
| P2.2 工具往返 | P2.1 | **verified** | 409321d、725f90e | 红：`npm test -w @di/agent`(1, 29 中 12 失败 = 全部工具相位用例，`LoopError tool-phase-not-implemented`)。绿：`npm run build -w @di/agent`(0)、`npm test -w @di/agent`(0, 29/29)、`npm run typecheck -w @di/agent`(0)、根 `npm run typecheck`(2, 仅 P4.1 在途的 @di/coding-agent 缺 createFileTools 等导出；@di/agent 与 @di/ai 均 0)、`npm.cmd --prefix tui test`(0, 116 pass)、`npm.cmd --prefix tui run build`(0) | 无 |
| P2.3 迭代上限与预算暂停 | P2.2 | **verified** | eb849ed、03f92d4 | 红：`npm test -w @di/agent`(1, 39 中 5 失败 = 全部 context-budget guard 用例：模型被错误调用 / 估算器未被调用)。绿：`npm run build -w @di/agent`(0)、`npm test -w @di/agent`(0, 39/39)、`npm run typecheck -w @di/agent`(0)、根 `npm run typecheck`(2, 仅 P3.3 在途的 @di/ai 的 src/providers 与 deepseek 测试文件；@di/agent 与 @di/coding-agent 均 0)、`npm.cmd --prefix tui test`(0, 116 pass)、`npm.cmd --prefix tui run build`(0) | 无 |
| P3 通用模型与 DeepSeek | P1 | in_progress | P3.1–P3.3（见子行）；P3.4 运行中 | 见子行 | 无 |
| P3.1 provider chunk assembler | P1.1 | **verified** | c0eb1de | 红：`npm test -w @di/ai`(1, 缺 AssemblerError 导出)。绿：`npm run build -w @di/ai`(0)、`npm run typecheck`(0)、`npm test -w @di/ai`(0, 27/27, 含 P1.1 回归) | 无；后续卡：SSE framing（P3.2） |
| P3.2 HTTP/SSE framing | P3.1 | **verified** | e0a2457 | 红：`npm test -w @di/ai`(1, 缺 SseEventParser 导出)。绿：`npm run build -w @di/ai`(0)、`npm run typecheck`(0)、`npm test -w @di/ai`(0, 59/59 = 32 新增 + 27 回归) | 无；后续卡：DeepSeek 翻译（P3.3） |
| P3.3 DeepSeek 请求/响应翻译 | P3.2 | **verified** | 5c36ca2 | 红：`npm test -w @di/ai`(1, 缺 DeepSeek 导出)。绿：`npm run build -w @di/ai`(0)、`npm run typecheck`(0)、`npm test -w @di/ai`(0, 90/90 = 31 新增 + 59 回归)、根 `npm run typecheck`(0) | 无；后续卡：usage/cost（P3.4，运行中） |
| P4 八个工具与平台执行 | P1 | in_progress | P4.1（见子行）；P4.2 运行中 | 见 P4.1 子行 | 预研已完成（27e3e60） |
| P4.1 文件工具 read/write/edit | P6.1, P1.2 | **verified** | 867e936 | 红：`npm test -w @di/coding-agent`(1, 缺 createEditFileTool 导出)；业务红（临时禁 OEM fallback）`node --test test/read-file.test.ts`(1, 35 中 2 失败=GBK 用例)。绿：`npm run build -w @di/coding-agent`(0)、`npm run typecheck`(0)、`npm test -w @di/coding-agent`(0, 114/114=88 工具+26 配置回归)、根 `npm run build`(0)、根 `npm run typecheck`(0)、`npm.cmd --prefix tui test`(0, 116 pass)、`npm.cmd --prefix tui run build`(0) | 无；FileShare.None 独占锁纯 Node 不可复刻；原子 rename 未做（保持基线原位写）；无解码器页（如 OEM 437）走显式解码错误（未加 iconv-lite）；后续卡：glob 枚举（P4.2） |
| P5 检查点、恢复和统计 | P2, P4 | todo | – | 未执行 | 无 |
| P6 Skills、配置、命令和日志 | P1 | in_progress | P6.1（见子行）；P6.2 待派 | 见 P6.1 子行 | 无 |
| P6.1 DI_HOME 解析、分层配置合并与 JSONC | P1.1 | **verified** | f96ca98 | 红：`npm run build -w @di/coding-agent && npm test -w @di/coding-agent`(1, 缺导出；再 1, 10/26 断言失败)。绿：`npm run build -w @di/coding-agent`(0)、`npm test -w @di/coding-agent`(0, 26/26)、`npm run typecheck -w @di/coding-agent`(0)；`@di/agent` 8/8(0)；TUI 116 pass(0) | 无；`--info` 属 P6.3；资源路径写入属 P6.2 |
| P7 TS 宿主 / RPC / 原 TUI | P3, P4, P5, P6 | todo | – | 未执行 | 无 |
| P8 ChatGPT 认证 | P3, 凭据存储接口 | todo | – | 未执行 | 预研已完成（27e3e60）；ChatGPT auth 实现未开始 |
| P9 本地 Runner、切换与完成 | P7, P8 | todo | – | 未执行 | 无 |
| P4-regex-probe（预研） | P4 | **verified** | 27e3e60 | `git show 27e3e60`(0)；发现见 probes/P4-regex-probe.md | 无 |
| P4-win-process-probe（预研） | P4 | **verified** | 27e3e60 | `git show 27e3e60`(0)；发现见 probes/P4-win-process-probe.md | 无 |
| P4-win-encoding-probe（预研） | P4 | **verified** | 27e3e60 | `git show 27e3e60`(0)；发现见 probes/P4-win-encoding-probe.md | 无 |
| P8-auth-storage-probe（预研） | P8 | **verified** | 27e3e60 | `git show 27e3e60`(0)；发现见 probes/P8-auth-storage-probe.md | 无 |

> `docs/migration/typescript-core/probes/` 已有四份预研发现（27e3e60 提交）；P1.2 及后续阶段据此推进。

## 证据位置

- 行为清单（源码/测试/目标模块/计划测试/门槛矩阵）：`docs/migration/typescript-core/behavior-ledger.md`（P0 提交创建）。
- 迁移契约唯一权威：`architecture.md`（模块映射）、`execution-plan.md`（阶段/门槛）、`loop-and-state.md`、`models-and-auth.md`、`tools-and-platform.md`、`sessions-and-compatibility.md`、`validation-and-release.md`。
- 基线测试临时产物：`/tmp/di-p0-baseline`（仅 P0 隔离 DI_HOME，不含凭据）；完整命令/退出码见本文件"基线非集成测试证据"。
- 基线源码/测试枚举：`git ls-tree -r --name-only 09f4e08 Core Common Di.Cli Di.Tests Di.Cli.Tests tui/src`（已核实）。
- P1.1 决策（后续卡片沿用）：本机 npm `11.13.0` 不支持 `workspace:` 协议（`EUNSUPPORTEDPROTOCOL`），workspace 依赖统一使用 `"*"`——本地 workspace 版本 `0.1.0` 满足 `*`，npm 直接链接本地包（见根 `package-lock.json` 的 `packages/*` 与 `node_modules/@di/*` 符号链接）。`@di/agent`、`@di/coding-agent` 均为占位 stub（可编译、可解析），P2 起才填真实循环契约。

## P1.2 交接（a8144ea、731f8b5）

- **交付：** `@di/agent` 工具调用词汇（`packages/agent/src/tools.ts` 的 `ToolExecutor` / `ToolValidator` / `ToolObservation`、`src/types.ts` 的 `AgentRequest`，从 `src/index.ts` 导出；`AgentMessage` / `ToolSpec` / `ToolCall` 从 `@di/ai` 导入不重定义）；记录型假执行器 `packages/agent/test/recording-executor.ts`（记录 id/name/arguments/order，返回 canned 结果）；跨语言 fixtures 位于仓库根 `fixtures/`（7 个场景：纯答案 / 工具往返 / 错误 / 软停 / 硬取消 / 预算暂停 / 恢复），schema 见 `fixtures/README.md` 与 `fixtures/schema.json`。
- **位置决策：** 文档未指定 loop fixture 位置（P5 session fixtures 属 `packages/coding-agent/test/fixtures/sessions/`，不在本期），故选仓库根 `fixtures/` 并记录于 fixtures/README.md。
- **红→绿：** 词汇导入测试先以导出缺失红（`npm run typecheck -w @di/agent` 退出 2，TS2305），实现后绿（0）。fixture 测试先以 fixtures 缺失红（`npm test -w @di/agent` 退出 1，ENOENT），创建后绿（8 pass / 0 fail）。fixture 预期全部来自 C# 基线 `09f4e08`（ReActTests / ReActInterruptTests / AgentRunnerTests）与叶子文档，非自生成。
- **工具词汇决策：** loop-and-state.md 为权威：`ToolObservation` 是 executor 结果（text + isError）；任务卡中的 "ToolResult" 无对应类型（`ToolResultMessage` 属 `@di/ai`），按文档落地为 `ToolObservation`；`AgentRequest` 字段按 loop-and-state.md 草图实现。
- **依赖的 @di/ai 形状：** `AgentMessage`（含 `ToolResultMessage` 成员）、`ToolCall`（`type:"tool-call"` + id/name/arguments 原始 JSON 串）、`ToolSpec`。`StopReason` 保留在 `@di/agent`。
- **未完成门槛：** 无。根 `package.json` 的 `test` script 仍只测 `@di/ai`（共享文件，留给集成者决定是否并入 `@di/agent`）。

## P3.1 交接（c0eb1de）

- **交付：** `packages/ai/src/stream-assembler.ts`（`ProviderChunk` / `ProviderBlockStart` / `ProviderStreamAssembler` / `AssemblerError`）从 `@di/ai` 公开导出；26 个测试 + P1.1 假模型回归（27/27）。provider 层 `ProviderChunk`（blockStart/textDelta/reasoningDelta/toolCallDelta/blockEnd/usage/finish + responseInfo）按 index 组装为内部消息；assembler 最终恰好产出一条 `completed`（含完整 assistant message、usage、finish reason、model、可选 cost/responseId/timestamp/durationMs）。缺终态抛 `AssemblerError missing-finish`（不伪造成功）；in-band 终态错误（finish reason=error/aborted）照常发 `completed` 携带该 reason 与已组装部分内容。其它非法序列用结构化错误码（chunk-after-finish / duplicate-block-start / delta-without-block / delta-type-mismatch / block-end-without-start / already-completed）。
- **工具调用：** 每 index 累积原始 JSON；`ModelEvent.toolCallDelta` 携带**累计** arguments（loop-and-state.md 约定，区别于 C# 转发原始 delta）；C# 回退镜像：缺 id → `call_{index}`、缺 name → `""`、空 arguments → `"{}"`（仅终块）。
- **依赖形状：** `ModelEvent` / `ModelResponse` 来自 P1.1 的 `stream.ts` / `model.ts`（未改动）；`ProviderChunk` 此前无预置位置（P1.1 注释明确推迟到本单元），故置于新文件，未改任何既有类型文件。
- **未完成门槛：** 无（本卡范围）。SSE/HTTP framing、DeepSeek 翻译、usage/cost、retry/timeout 均为后续 P3 卡；字节级 UTF-8 `TextDecoder` 分片处理属 P3.2。

## P2.1 交接

- **交付：** `packages/agent/src/types.ts` 新增 `AgentResult` / `AgentEvent` / `AgentDependencies` / `LoopCheckpoint`，`StopReason` 从 `index.ts` 移入并重导出；新建 `packages/agent/src/agent-loop.ts`（`runAgentLoop` 无工具答案路径 + `LoopError`）；`src/index.ts` 导出全部新类型与 `runAgentLoop` / `LoopError`。测试 `packages/agent/test/agent-loop.test.ts` 新增 10 条（纯答案 fixture、上下文拼装、systemContext、空 systemPrompt、history 前置且不被修改、delta 转发顺序、空文本/空工具、缺 completed 拒绝、参数越界拒绝、工具请求响亮失败），P1.2 8 条回归全绿，共 18 pass。
- **红→绿：** 红为 `npm test -w @di/agent` 退出 1（`@di/agent` 无 `runAgentLoop` 命名导出）与 `npm run typecheck -w @di/agent` 退出 2（TS2305 缺 `AgentDependencies`/`AgentEvent`/`LoopError`/`runAgentLoop`）。实现后绿：build(0)、test(0, 18 pass)、typecheck(0)、根 typecheck(0)、TUI test(0, 116 pass)、TUI build(0)。
- **类型决策：** 全部按 loop-and-state.md §"建议公开的最小 loop types"；`AgentEvent` 放 `types.ts`（architecture.md 的 `events.ts` 属规划位置，leaf 文档明确允许 types.ts/tools.ts）。`AgentResult.history` 原样返回调用方数组（不修改）；`cost`/`failure` 未上报时为 undefined（对照 fixture 的 null 用 `?? null` 断言）。
- **实现决策：** trajectory = history + userMessage（不触碰调用方数组）；模型请求上下文 = 非空 systemPrompt 稳定前缀 + trajectory + 非空 systemContext 尾部 system 消息（镜像 `ReAct.BuildContext`）；单次模型调用，delta（textDelta/reasoningDelta/toolCallDelta）按序 await 转发；`completed` 取最后一次、缺 `completed` 抛 `LoopError("missing-completed")`；usage/cost 按 C# `TokenUsage.Add` / `CombineCost` 语义累加（可空字段单侧存在保留另一侧）；`checkpoint.appendMessage` 先于 `turnCompleted`；无工具调用返回 `stopReason=answer`；模型返回工具调用抛 `LoopError("tool-phase-not-implemented")`（诚实边界，不伪造答案、不静默执行工具）。事件顺序：纯答案路径事件序列为 `["turnCompleted"]`（ScriptedModel 只发 `completed`，与 fixture eventSequence 一致）；delta 转发另用流式模型单独测试。
- **消息良构：** `maxIterations` 整数且 >= 0（0=无限）、`maxTokens` 正整数、`contextTokenBudget` 整数且 >= 0，越界在 loop 启动时抛 `RangeError`（不静默 clamp）；空 userMessage / 空 tools 正常处理不崩溃；provider 空 stream / 缺 finish 拒绝。
- **未完成门槛：** 无（本卡范围）。工具往返（P2.2）、迭代上限 / 预算暂停、软停 / 硬取消、观察事件异常隔离、跨回合历史 / 快照、模型切换均为后续 P2 卡；`runAgentLoop` 当前对工具调用直接抛错，P2.2 落地前不可接真实工具。

## P2.2 交接（409321d、725f90e）

- **交付：** `packages/agent/src/agent-loop.ts` 的 `runAgentLoop` 从单次模型调用改为 `while (maxIterations === 0 || iterations < maxIterations)` 循环，加入工具相位：每个 tool call 按模型给出顺序依次——命中 `finalOutputTool` 则原始 arguments 作为答案返回（不执行）；预算耗尽（`maxIterations > 0 && iterations >= maxIterations`）则不执行剩余工具、循环退出返回 `max_iterations`；否则 `toolValidator?.validate` → `beforeToolExecution?.(trajectory)` → `signal?.throwIfAborted()`（硬取消）→ `checkpoint.toolStarted`（写前 intent，失败则工具绝不运行）→ emit `toolStarted` → `executeTool` → emit `toolCompleted` → observation 转 `ToolResultMessage` 加入 trajectory → `checkpoint.toolCompleted`（结果持久后才允许下一次模型调用）。测试 `packages/agent/test/agent-loop.test.ts` 新增 12 条（fixture 契约 + 多工具顺序 + 异常转 isError + validator 校验/拒绝 + beforeToolExecution 调用/抛错 + checkpoint intent 失败防执行 + checkpoint/observer 事件顺序 + finalOutputTool + maxIterations + usage 跨轮累加），删除 P2.1 的 `tool-phase-not-implemented` 边界测试；`src/index.ts` 头注释更新。共 29 pass（= P2.1 回归 17 + 新 12）。
- **红→绿：** 红为 `npm test -w @di/agent` 退出 1（29 中 12 失败，全部新工具相位用例抛 `LoopError tool-phase-not-implemented`，与任务卡约定一致）。实现后绿：build(0)、test(0, 29/29)、typecheck -w(0)；根 typecheck 退出 2 仅因 P4.1 在途的 `@di/coding-agent`（`createEditFileTool`/`createReadFileTool`/`createFileTools`/`createToolExecutor` 导出缺失），@di/agent 与 @di/ai 均干净；TUI test(0, 116 pass)、TUI build(0)。
- **工具相位设计决策：** 全部按 loop-and-state.md §"一回合精确时序" step 6 与 C# `ReAct.RunCoreAsync` 次序：validator → beforeToolExecution → 硬信号 → checkpoint intent → toolStarted → 执行 → toolCompleted → 观察入轨迹 → checkpoint result。`final_output_tool` 先于预算检查（对齐 C#：最后迭代也尊重 final tool）。工具异常转 `error executing tool '<name>': <message>` 的 isError 观察，绝不伪造成功；仅 `AbortError`（硬取消）向上传播为 rejection，不被通用 catch 转观察（loop-and-state.md 明确要求）。多工具同轮按序执行（本卡行为描述含此项，故一并落地并有测试，不属跨卡抢工）。`emit` 仍 await 但不隔离 observer 异常（隔离属后卡）。
- **fixture 期望满足：** `fixtures/tool-round-trip.json` 全部命中——stopReason=answer、answer="done"、iterations=2、usage `{0,0}`、cost/failure null、modelRequestCount=2、eventSequence `["turnCompleted","toolStarted","toolCompleted","turnCompleted"]`、executor 记录 `[{call_1,echo,{"x":1},order:1}]`、trajectoryCount=4 且 trajectory 深度相等。
- **未完成门槛：** 无（本卡范围）。迭代预算暂停（`contextTokenBudget` 的 `context_limit` guard）、多工具批的独立验收（本卡已按序执行）、软停 / 硬取消、观察事件异常隔离、历史 / 快照、模型切换均为后续 P2 卡。

## P3.2 交接（e0a2457）

- **交付：** `packages/ai/src/sse.ts`（`SseEvent` / `SseEventParser` / `SseStreamError` / `parseSseStream` / `TranslateEvent` / `sseToModelEvents`）从 `@di/ai` 公开导出；32 个测试 + 回归（59/59）。纯 push 式 SSE 状态机：per-char 扫描 + pending-CR 标志使 `\n` / `\r\n` / 孤立 `\r` 均能断行，CRLF 跨 chunk 分裂正确合并；W3C 字段语法（data/event/id、`:` 注释）、多行 data 以 `\n` 连接、空行派发；EOF 派发未决 data（不伪造空事件——红测抓到并修复）。字节解码用流式 `TextDecoder` + EOF flush，多字节跨帧正确重装。
- **Idle 超时 / 中止：** `readWithGuard` 对每次 read 竞速 `setTimeout`，settle/abort 时总是清 timer（无泄漏，进程干净退出）；超时抛 `SseStreamError("timeout")`；调用方 signal reject 为 `SseStreamError("aborted")` 并 `reader.cancel()` 关闭连接；底层 `AbortError` 映射为 `aborted` 而非 `connection`。
- **连接错误映射：** `ModelEvent` 无错误变体 → 传输/协议失败从 `AsyncIterable` **抛** `SseStreamError(code)`（永不挂起、不伪造成功）；in-band provider 错误以 `completed` 到达（finishReason `{type:"error"|"aborted", failure}`）；EOF 无终态 finish = 协议截断 → `SseStreamError("connection")`（可重试）。`IteratorClose` 保证消费者提前 break 时释放 reader 锁并关闭连接。
- **依赖形状：** 直接消费 P3.1 的 `ProviderStreamAssembler` / `ProviderChunk` / `AssemblerError`（未改动）；缺终态由 glue 跟踪 `sawFinish` 抛 `"connection"`，不依赖 `AssemblerError("missing-finish")`。
- **未完成门槛：** 无（本卡范围）。DeepSeek 线协议翻译 + `[DONE]`/坏 JSON 跳过（P3.3，`TranslateEvent` 接缝已留）、usage/cost（P3.4）、retry/backoff + 响应头等待 + 非 2xx/Retry-After 映射（P3.5）。

## P6.1 交接（f96ca98）

- **交付：** `packages/coding-agent/src/core/config/`（`di-home.ts` 的 `DiHome`、`di-config.ts` 的 `DiConfig.merge`/`load` + `DEFAULT_CONFIG`、`jsonc.ts` 的 `parseJsonc`/`parseJsonObject`/`ConfigParseError`）从 `src/index.ts` 导出；26 个测试。DI_HOME：env 优先、空白回退 `<userHome>/.di`、非空原样使用（相对路径保持相对，不调用 `GetFullPath`，与 C# 一致）；env/userHome 显式注入，无隐藏全局读取；测试全部隔离临时目录，用户配置只读不被创建/覆盖。
- **合并：** 每来源扁平化为小写 `:`-key map，后层按 key 覆盖（深层合并而非浅层 spread，有专门测试拦截 `{...user,...project}`）；优先级 default → user → project → env；env 变量 `__`→`:`（单 `_` 字面量）、全部加载（对齐裸 `AddEnvironmentVariables()` 无前缀过滤）；JSON 值保留原生类型（number/bool/null），`get` 对 present-null 返回 `null`、missing 返回 `undefined`，`has()` 区分；未知键无害可寻址；非对象根/坏文件抛 `ConfigParseError`（对齐 .NET 坏配置失败），缺失文件可选。
- **JSONC 依赖（按 operator-guide 新增依赖规则）：** `jsonc-parser@3.3.1`（精确固定，MIT）。用途：解析容忍注释+尾逗号的用户/项目配置与默认值。公共 API：`parse`、`printParseErrorCode`、`ParseError`（仅类型导入）。最小 Node：纯 JS 无依赖。**集成前最小探针 6/6 通过**（exit 0）：命名 ESM 导入解析、行/块注释与尾逗号零错误、number/float/bool/null 保留、坏文档填充带 offset/length 的错误、`printParseErrorCode` 返回字符串。锁文件 diff 仅含 `jsonc-parser` 条目 + coding-agent 依赖，无其它churn。
- **未完成门槛：** 资源路径解析/写入（`sessions/` `logs/` `artifacts/` 权限受控 `auth/`、跨 dev checkout/安装包/任意 CWD 定位一致）属 P6.2；`--info` 如实报告属 P6.3 CLI。

## P2.3 交接（eb849ed、03f92d4）

- **交付：** `packages/agent/src/agent-loop.ts` 的 `runAgentLoop` 加入 context 预算 guard：每次发起下一次模型请求前（硬取消之后、iteration 递增之前；对齐 `ReAct.RunCoreAsync` 次序：硬取消 → 软停止 → context 检查，软停止属后卡，占位注释保留），构造本次模型请求 `buildModelRequest` 后调用注入的 `estimateRequestTokens`。`contextTokenBudget === 0` 无条件返回 `context_limit`；`estimate > contextTokenBudget` 返回 `context_limit`（估算恰等于预算可继续）；预算未设置不启用 guard。`streamModel` 改为接收预先构造的 `modelRequest`，保证估算器与模型看到完全相同的请求（测试用引用同一性锁定）。
- **answer 语义：** `context_limit` 的 answer 对齐 C# `StopContextLimit`——跳过 history 前缀 + 当前 user 后的最后一个 assistant 文本；空 history 时 ""（budget-pause fixture 命中）。新增 `contextLimitAnswer`（区别于 `lastAssistantText`：后者不过滤 history 前缀，`RunAsync_ContextLimitDoesNotReturnAnOldHistoryAnswer` 语义有专门测试）。`context_limit` 保留完整 trajectory 与已发生 usage/cost，绝不自动裁剪/摘要（显式暂停）。
- **测试：** `packages/agent/test/agent-loop.test.ts` 新增 10 条（budget-pause fixture 全断言、`contextTokenBudget=0` 无条件暂停、估算=预算可继续、无预算禁用 guard、工具往返后预算越线保留轨迹与 usage、answer 不返回旧 history assistant、估算器与模型共享同一请求、无默认迭代上限 >24 轮继续、`maxIterations=1`、多工具单轮 + N 上限）。红测 `npm test -w @di/agent` 退出 1（39 中 5 失败 = 全部新 guard 用例：模型被错误调用或估算器未被调用）；实现后 39/39（P2.2 29 回归 + 新 10）。
- **并行干扰记录：** P3.3 在途重建 `@di/ai` dist 曾使 dist 指向不存在的 `providers/types/content.js`，导致 `@di/agent` 测试 import 失败；本单元已用提交态 `@di/ai` src 重建干净 dist 恢复验证（未触碰 P3.3 的 src 文件）。若后续再现 `@di/ai` dist 破损，属 P3.3 在途状态，非 P2.3 失败。
- **未完成门槛：** 无（本卡范围）。软停 / 硬取消（P2.4）、观察事件与 checkpoint hook 异常隔离、历史 / 快照 / budget tracker、模型切换均为后续 P2 卡。

## P3.3 交接（5c36ca2）

- **交付：** `packages/ai/src/providers/deepseek/`（`wire.ts` DTO、`translator.ts` 请求翻译 + 字节稳定序列化 + `createDeepSeekTranslator`、`adapter.ts` `DeepSeekAdapter implements ChatModel`、`index.ts`）从 `@di/ai` 公开导出；31 个测试 + 回归（90/90）。请求：`toWireRequest` 按 C# 序列化器字段顺序输出字节稳定 snake_case JSON；未设字段省略（绝不 `null`/`[]`/`""`）；`thinking` 由 `reasoningEffort` 映射（off→disabled、low/high/max→enabled+effort、默认省略、未知→`UNSUPPORTED_OPTION`）；assistant 历史回显 `reasoning_content` + `tool_calls`；工具结果映射 `tool_call_id`。响应：状态化 `TranslateEvent` 闭包被 `sseToModelEvents` 消费；固定块索引（reasoning=0、text=1、tool wireIndex n→2+n）使最终内容顺序对齐 C# assembler；`toolCallDelta` 仅当 wire 提供时才带 id/name（空串会覆写真实 id——首个实现尝试已修复）。
- **[DONE] / 坏 JSON / 非 2xx：** `[DONE]` 为 no-op 终态；带 finish chunk + `[DONE]` 恰好一条 `completed`；只有 `[DONE]` 无 finish → `connection` `SseStreamError`（不伪造）。`JSON.parse` 失败或结构非法 → `[]` 跳过不崩流。`mapHttpErrorBody`：429→`RATE_LIMITED`、401/403→`MISSING_CREDENTIAL`、其它取 body code/type→`INVALID_REQUEST` 回退；`DeepSeekError` 携带 `LlmFailure` + code/status/`providerRetryAfterMs`（供 P3.5）。adapter 读 `Retry-After`（delta 秒/HTTP-date）；缺/空 apiKey 在 fetch 前抛 `MISSING_CREDENTIAL`。
- **依赖形状：** `sseToModelEvents(stream, { model, translateEvent, idleTimeoutMs?, signal? })` 的 `TranslateEvent` 接缝；未改 `sse.ts` / `stream-assembler.ts` / `src/types/*`。
- **未完成门槛：** 无（本卡范围）。成本计算（P3.4）、retry/backoff + 响应头等待 + 非 2xx/Retry-After 策略（P3.5）。

## P4.1 交接（867e936）

- **交付：** `packages/coding-agent/src/core/tools/`（`types.ts` `CoreTool` = `{ spec: ToolSpec, promptSnippet, promptGuidelines, execute(argumentsJson, signal?) → Promise<ToolObservation> }`、`errors.ts`、`args.ts` parse/validate + JSON-Schema builder、`paths.ts` resolvePath、`encoding.ts` SmartDecode + OEM 发现、`read.ts`/`write.ts`/`edit.ts`、`index.ts` `createFileTools`/`createToolExecutor`）从 `src/index.ts` 导出；88 个工具测试 + 26 配置回归（114）。`createToolExecutor` 适配 `@di/agent.ToolExecutor`（未知工具名 → `error: 未知工具 'x'` 观察；signal 透传；AbortError 传播不吞）。read 按编码探针：去 UTF-8 BOM → strict UTF-8（fatal）→ 1–3 字节接缝修剪 → 系统 OEM（懒 `chcp.com` 发现 + 缓存 + CP→TextDecoder label map）；本机 OEM=936，GBK fixture 命中；无解码器页（437）显式错误。
- **错误路径 / 平台证据：** read/write/edit 覆盖缺路径/越界/非法 JSON/NUL/目录目标/父为文件/只读(EPERM)/abort 不落盘不碰文件；Windows 反斜杠相对路径、CRLF 读写保留（edit 写回仍 CRLF）、BOM 保留/剥离均实测。
- **诚实边界：** 锁文件（FileShare.None）错误路径纯 Node 无法复刻（libuv 默认共享读写，无原生独占锁 API 且不加依赖）→ 未移植 C# Windows 锁测试，已记录未伪造；原子写（temp+rename）未做——保持 MVP 对齐 C# 原位 `File.WriteAllText` 基线；无新依赖（iconv-lite 推迟）。
- **未完成门槛：** 无（本卡范围）。glob 枚举（P4.2，运行中）、grep/regex（P4.3，用 regex 探针 worker 终止边界）、进程/持久 shell（后续）。

## 下一张任务卡（P2 第四个单元：软停与硬取消）

- **ID：** P2.4-soft-stop-hard-cancel
- **输入：** 现有 `runAgentLoop`（P2.3，已含 context-budget guard、`maxIterations`、工具相位与 loop-top 的 `signal?.throwIfAborted()`）；`AgentDependencies.interruptRequested?: () => boolean`（软停止轮询，loop-and-state.md §"建议公开的最小 loop types" 已定义）；C# 基线 `ReAct.RunCoreAsync` 的两个相位边界软停止检查（进入模型相位前 / 模型刚产出 tool calls 后工具尚未启动时）与 `StopInterrupted`；`fixtures/soft-stop.json`（`softStopAfterTurn: 1`：模型第 1 次返回工具调用后请求软停；期望 stopReason=interrupted、answer="let me check"、iterations=1、modelRequestCount=1、eventSequence=["turnCompleted","interrupted"]、toolCalls=[]、trajectoryCount=2）与 `fixtures/hard-cancel.json`（`cancelAfterTool: true`：首工具执行完成后 abort；期望 rejects `AbortError`、iterations=1、eventSequence=["turnCompleted","toolStarted","toolCompleted"]、toolCalls=[c1 done]、trajectoryCount=3）。
- **行为：** 软停止（`interruptRequested()` 返回 true 时）在两个相位边界检查：进入下一次模型调用前（优先于 context guard；次序 硬取消 → 软停止 → context 检查）与模型刚返回 tool calls、工具尚未执行时。命中即返回 `stopReason=interrupted`（发 `{ type: "interrupted" }` 事件），不执行未启动的工具、不再发起模型调用，保留已产生轨迹 / usage，answer 为模型可见文本（soft-stop fixture 的 "let me check"）。硬取消沿用 AbortSignal：loop-top 与工具执行前 `signal?.throwIfAborted()`；模型流 / 工具执行中的 AbortError 向上 rejection（hard-cancel fixture：`rejects AbortError`，轨迹保留已完成的工具观察）；AbortError 绝不能转成普通 isError 观察（P2.2 已隔离，需回归确认）。
- **红测：** 以 `soft-stop.json` 期望断言：模型返回工具调用后 `interruptRequested()` 返回 true 时 stopReason=interrupted、工具不执行、无后续模型调用；当前实现没有 `interruptRequested` 检查（会执行工具并继续 / 返回 answer），先红。软停在 loop-top（context guard 之前）的命中、硬取消 fixture（工具完成后 abort 的 AbortError rejection 与事件 / 轨迹保留）、模型流中途 abort 的 rejection 也应有测试。
- **实现：** 最小实现：loop-top 的硬取消之后、context guard 之前插入 `interruptRequested?.()` 检查（命中返回 interrupted 结果）；工具相位 for 循环之前（final-output-tool 检查之后）插入软停止检查（命中返回 interrupted，绝不启动工具）。复用 `StopInterrupted` 的 answer 语义（模型可见文本即答案）与既有 `signal?.throwIfAborted()` 点位；模型流 / 工具执行中途取消的透传语义如需补强仅在测试层落实，不改模型流接口。
- **绿测：** `npm test -w @di/agent`（P2.3 回归 39 + 新用例）；`npm run typecheck -w @di/agent`；根 `npm run typecheck`（P3.3 在途的 @di/ai 红不计）；`npm.cmd --prefix tui test`（116 pass）与 `npm.cmd --prefix tui run build`。
- **后续卡（按 operator-guide P2 顺序）：** 观察事件与 checkpoint hook 异常隔离 → 历史 / 快照 / budget tracker → 模型切换。
