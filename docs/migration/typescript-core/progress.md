# TypeScript Core 迁移：进度表

> **状态：P0–P2.5 各单元、P3.1–P3.5（@di/ai 全部完成）、P4.1–P4.3、P6.1 与四项预研均已完成；P2.6 运行中（本文件由 P0 提交创建，各迁移单元更新）。** 只保存简短状态表与证据位置，不复制专题契约；
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
| P2 纯循环与宿主状态 | P1 | in_progress | P2.1–P2.5（见子行）；历史/快照/budget tracker、模型切换待派 | 见 P2.1 / P2.2 / P2.3 / P2.4 / P2.5 子行 | 无 |
| P2.1 无工具答案路径与消息良构 | P1.2 | **verified** | 见 P2.1 交接 | 红：`npm test -w @di/agent`(1, 缺 runAgentLoop 导出)、`npm run typecheck -w @di/agent`(2, TS2305)。绿：`npm run build -w @di/agent`(0)、`npm test -w @di/agent`(0, 18 pass)、`npm run typecheck -w @di/agent`(0)、根 `npm run typecheck`(0)、`npm.cmd --prefix tui test`(0, 116 pass)、`npm.cmd --prefix tui run build`(0) | 无 |
| P2.2 工具往返 | P2.1 | **verified** | 409321d、725f90e | 红：`npm test -w @di/agent`(1, 29 中 12 失败 = 全部工具相位用例，`LoopError tool-phase-not-implemented`)。绿：`npm run build -w @di/agent`(0)、`npm test -w @di/agent`(0, 29/29)、`npm run typecheck -w @di/agent`(0)、根 `npm run typecheck`(2, 仅 P4.1 在途的 @di/coding-agent 缺 createFileTools 等导出；@di/agent 与 @di/ai 均 0)、`npm.cmd --prefix tui test`(0, 116 pass)、`npm.cmd --prefix tui run build`(0) | 无 |
| P2.3 迭代上限与预算暂停 | P2.2 | **verified** | eb849ed、03f92d4 | 红：`npm test -w @di/agent`(1, 39 中 5 失败 = 全部 context-budget guard 用例：模型被错误调用 / 估算器未被调用)。绿：`npm run build -w @di/agent`(0)、`npm test -w @di/agent`(0, 39/39)、`npm run typecheck -w @di/agent`(0)、根 `npm run typecheck`(2, 仅 P3.3 在途的 @di/ai 的 src/providers 与 deepseek 测试文件；@di/agent 与 @di/coding-agent 均 0)、`npm.cmd --prefix tui test`(0, 116 pass)、`npm.cmd --prefix tui run build`(0) | 无 |
| P2.4 软停与硬取消 | P2.3 | **verified** | 7f33e9a、ed8064f | 红：`npm test -w @di/agent`(1, 45 中 3 失败 = 全部软停止用例：模型被调用/继续执行工具，返回 answer 而非 interrupted；hard-cancel / 中途 abort / AbortError 隔离 3 条已实现直接绿)。绿：`npm run build -w @di/agent`(0)、`npm test -w @di/agent`(0, 45/45=39 回归+6 新)、`npm run typecheck -w @di/agent`(0)、根 `npm run typecheck`(0, P3.4/P4.2 在途当前 typecheck-clean)、`npm.cmd --prefix tui test`(0, 116 pass)、`npm.cmd --prefix tui run build`(0) | 无 |
| P2.5-observer-isolation | P2.4 | **verified** | 5ddcf92（test 红）、b9d584a（feat 绿）、progress.md 见下 | 红：`npm test -w @di/agent`(1, 50 中 3 失败 = 全部 observer 隔离用例：sink 抛错经 `emit` 传播使 run rejection，工具不执行；2 条 checkpoint fail-closed 确认用例已实现直接绿)。绿：`npm run build -w @di/agent`(0)、`npm test -w @di/agent`(0, 50/50=45 回归+5 新)、`npm run typecheck -w @di/agent`(0)、根 `npm run typecheck`(0, P3.5/P4.3 在途当前 typecheck-clean)、`npm.cmd --prefix tui test`(0, 116 pass)、`npm.cmd --prefix tui run build`(0) | 无 |
| P3 通用模型与 DeepSeek | P1 | **verified** | P3.1–P3.5（见子行） | 见 P3.1 / P3.2 / P3.3 / P3.4 / P3.5 子行；@di/ai 全部完成 | 无 |
| P3.1 provider chunk assembler | P1.1 | **verified** | c0eb1de | 红：`npm test -w @di/ai`(1, 缺 AssemblerError 导出)。绿：`npm run build -w @di/ai`(0)、`npm run typecheck`(0)、`npm test -w @di/ai`(0, 27/27, 含 P1.1 回归) | 无；后续卡：SSE framing（P3.2） |
| P3.2 HTTP/SSE framing | P3.1 | **verified** | e0a2457 | 红：`npm test -w @di/ai`(1, 缺 SseEventParser 导出)。绿：`npm run build -w @di/ai`(0)、`npm run typecheck`(0)、`npm test -w @di/ai`(0, 59/59 = 32 新增 + 27 回归) | 无；后续卡：DeepSeek 翻译（P3.3） |
| P3.3 DeepSeek 请求/响应翻译 | P3.2 | **verified** | 5c36ca2 | 红：`npm test -w @di/ai`(1, 缺 DeepSeek 导出)。绿：`npm run build -w @di/ai`(0)、`npm run typecheck`(0)、`npm test -w @di/ai`(0, 90/90 = 31 新增 + 59 回归)、根 `npm run typecheck`(0) | 无；后续卡：usage/cost（P3.4） |
| P3.4 usage 聚合与成本计算 | P3.1+P3.2+P3.3 | **verified** | 269ff93 | 红：`npm test -w @di/ai`(1, 缺 billableInputTokens 导出)。绿：`npm run build -w @di/ai`(0)、`npm run typecheck -w @di/ai`(0)、`npm test -w @di/ai`(0, 123/123 = 90 回归 + 33 新增)、根 `npm run typecheck`(0)、`npm test -w @di/agent`(0, 45/45) | 无；后续卡：retry/timeout（P3.5） |
| P3.5 retry/timeout 与超时 | P3.1..P3.4 | **verified** | bf48fdb、0394c41 | 红：`npm test -w @di/ai`(1, 缺 retry 导出 + 缺 header TIMEOUT rejection + 连接映射 false)。绿：`npm run build -w @di/ai`(0)、`npm run typecheck -w @di/ai`(0)、`npm test -w @di/ai`(0, 150/150=123 回归+27 新)、根 `npm run typecheck`(0)、`npm test -w @di/agent`(0, 50/50) | retry/timeout 完成；P3 阶段全部完成；后续卡：P4.4 输出收集 |
| P4 八个工具与平台执行 | P1 | in_progress | P4.1–P4.3（见子行）；P4.4 待派 | 见 P4.1 / P4.2 / P4.3 子行 | 预研已完成（27e3e60） |
| P4.1 文件工具 read/write/edit | P6.1, P1.2 | **verified** | 867e936 | 红：`npm test -w @di/coding-agent`(1, 缺 createEditFileTool 导出)；业务红（临时禁 OEM fallback）`node --test test/read-file.test.ts`(1, 35 中 2 失败=GBK 用例)。绿：`npm run build -w @di/coding-agent`(0)、`npm run typecheck`(0)、`npm test -w @di/coding-agent`(0, 114/114=88 工具+26 配置回归)、根 `npm run build`(0)、根 `npm run typecheck`(0)、`npm.cmd --prefix tui test`(0, 116 pass)、`npm.cmd --prefix tui run build`(0) | 无；FileShare.None 独占锁纯 Node 不可复刻；原子 rename 未做（保持基线原位写）；无解码器页（如 OEM 437）走显式解码错误（未加 iconv-lite）；后续卡：glob 枚举（P4.2） |
| P4.2 glob 文件枚举 | P4.1 | **verified** | 1c08756 | 红：`npm test -w @di/coding-agent`(1, 缺 globIsMatch/createGlobTool/GLOB_DEFAULT_LIMIT 导出)。绿：`npm run build -w @di/coding-agent`(0)、`npm run typecheck -w @di/coding-agent`(0)、`npm test -w @di/coding-agent`(0, 162 = 114 回归 + 48 新增, 161 pass + 1 win-symlink 平台跳过)、根 `npm run typecheck`(0)、`npm.cmd --prefix tui test`(0, 116 pass)、`npm.cmd --prefix tui run build`(0) | 无；Windows 文件符号链接创建需管理员/开发者模式（EPERM）→ symlink-file 用例本机跳过、POSIX CI 运行；后续卡：grep/regex（P4.3） |
| P4.3 grep/regex 搜索 | P4.2 | **verified** | 37fd82f、6e32deb | 红：`npm test -w @di/coding-agent`(1, SyntaxError 缺 GREP_DEFAULT_LIMIT 导出)。绿：`npm run build -w @di/coding-agent`(0)、`npm run typecheck -w @di/coding-agent`(0)、`npm test -w @di/coding-agent`(0, 207 = 162 回归 + 45 新增, 206 pass + 1 win-symlink 平台跳过)、根 `npm run typecheck`(0)、`npm.cmd --prefix tui test`(0, 116 pass)、`npm.cmd --prefix tui run build`(0) | worker_threads 每调用一个 worker，超时/中止 worker.terminate()（灾难回溯 `(x+x+)+y` 30 x 560ms 内返回）；u flag + \A\z\Z 桥接；.NET 独有语法显式 error 非静默空；GBK/OEM 936 解码匹配；JS \w\d\b 仅 ASCII 未补译（记录已知差异，conformance 门未过）；空标记用 C#「（未找到匹配）」；后续卡：P4.4 输出收集 |
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

## P2.4 交接（7f33e9a、ed8064f）

- **交付：** `packages/agent/src/agent-loop.ts` 的 `runAgentLoop` 加入软停止 `interruptRequested?: () => boolean`（类型 P1.2/P2.1 已就位，无类型缺口）的两个相位边界检查与 `stopInterrupted` helper。B0/B2（loop-top，硬取消 `signal?.throwIfAborted()` 之后、context guard 之前；次序 硬取消 → 软停止 → context 检查）：命中返回 `interrupted`，不发模型调用、不触发估算器。B1（模型刚返回 tool calls、`toolCalls.length===0` 的 answer 路径之后、工具 for 循环之前）：命中返回 `interrupted`，绝不启动未开始的工具。`stopInterrupted` 复用 C# `StopInterrupted`：`answer = lastAssistantText(trajectory)`（模型可见文本），保留完整轨迹 / 已发生 usage/cost，`await emit({type:"interrupted"})` 后返回。硬取消保持 AbortSignal：loop-top + 工具前 `signal?.throwIfAborted()`；模型流 / 工具执行中 AbortError 向上 rejection，绝不转 isError 观察（P2.2 `executeTool` 的 `isAbortError` 再抛出，本卡补回归测试）。
- **测试：** `packages/agent/test/agent-loop.test.ts` 新增 6 条（P2.3 回归 39 + 新 6 = 45）：soft-stop fixture 全断言（B1：interrupted / answer="let me check" / iterations=1 / modelRequestCount=1 / eventSequence=["turnCompleted","interrupted"] / executor 零调用 / trajectoryCount=2 且深度相等）；loop-top 软停在 context guard 之前（estimator 零调用、model 零调用、interrupt 事件发出）；B2 工具执行途中软停（已开始工具跑完、观察保留、下次模型调用前 interrupted）；hard-cancel fixture（AbortError rejection、eventSequence、executor 记录 c1 done、checkpoint 记录 [assistant, tool result] 证明工具观察保留）；模型流中途 abort rejection；工具抛 AbortError 不转 isError 观察（回归确认）。`ScriptedModel` 扩展支持 fixture `fallback` 脚本（hard-cancel.json `responses:[]` + fallback）。
- **红→绿：** 红为 `npm test -w @di/agent` 退出 1（45 中 3 失败 = 全部软停止用例：soft-stop fixture 继续到第 2 次模型调用、loop-top 与 B2 返回 answer 而非 interrupted；hard-cancel / 中途 abort / AbortError 隔离 3 条已实现直接绿）。实现后绿：build(0)、test(0, 45/45)、typecheck -w(0)；根 typecheck(0，P3.4/P4.2 在途当前 typecheck-clean)；TUI test(0, 116 pass)、TUI build(0)。
- **设计决策：** B1 软停检查置于工具 for 循环之前、final-output-tool 检查之前（对齐 loop-and-state.md §"一回合精确时序" step 6「有 tool call 时先检查软停止」与 C# `ReAct.RunCoreAsync` 的 B1 检查在 foreach 之前；任务卡括注「final-output-tool 检查之后」与 C# 次序相抵，fixture 未区分该场景，按权威文档落地——软停优先于 final output tool）。`interruptRequested` 缺省 undefined 时 `.?.()===true` 为 false，既有行为不变（C# `NoSignal_NeverInterrupts` 回归语义）。answer 复用 `lastAssistantText`（不过滤 history 前缀，与 C# `StopInterrupted` 一致，区别于 `contextLimitAnswer`）。
- **未完成门槛：** 无（本卡范围）。观察事件与 checkpoint hook 异常隔离、历史 / 快照 / budget tracker、模型切换均为后续 P2 卡。

## P3.4 交接（269ff93）

- **交付：** `packages/ai/src/usage.ts`（`TokenUsage` 聚合 + 成本计算：`tokenUsageZero` / `tokenUsageAdd` / `billableInputTokens` / `cacheHitRate` / `usageCostZero` / `usageCostTotal` / `usageCostAdd` / `combineCost` / `calculateCost` / `costForModel`）与 `packages/ai/src/catalog.ts`（`ModelSpec` / `MODEL_CATALOG` / `findModelCostRates`）从 `@di/ai` 公开导出；33 个新测试 + 回归（123/123）。
- **聚合语义：** `tokenUsageAdd` 的必填 `inputTokens`/`outputTokens` 恒求和；可选字段（`totalTokens` / `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens`）按 `SumOrNull`——单侧 undefined 保留另一侧、双侧 undefined 仍 undefined（`add(Zero, x) == x`，对齐 `TokenUsage.cs` 与 agent-loop 私有 `addUsage`）。派生计费数（`billableInputTokens` / `cacheHitRate` / `calculateCost`）将缺失缓存字段按 **0** 处理——与聚合语义的刻意差异，对齐 `TokenUsage.BillableInputTokens` / `CostCalculator`。
- **成本目录（数据驱动）：** 费率纯数据转录自 C# 基线 adapter 的 `Catalog`——`deepseek-flash` 0.28/0.42/0.07（cacheWrite 0）、`deepseek-v4-pro` 1.20/4.00/0.30、`chatgpt/gpt-6.1-sol` **刻意无 cost**（订阅制）。新增模型 = 数据改动，不动引擎代码。**未知成本绝不伪造为零**：`costForModel` 对未知 provider/model 或该模型无费率返回 `undefined`；`combineCost(undefined, x) == x`、`combineCost(undefined, undefined) == undefined`；`ModelResponse.cost` 仅在定义时展开（assembler 测试断言 `"cost" in response === false`）。cacheRead/cacheWrite 按各自更低价计（v4-pro cacheRead=$0.30/M，不用 flash 的 $0.07）。
- **cost 注入接缝：** `ProviderStreamAssemblerOptions` 新增可选 `cost?: (usage) => UsageCost | undefined`，在 `finish()` 恰一次调用；`SseToModelEventsOptions` 透传至 assembler。镜像 C# `ChatModelClient.StreamAsync → LlmRuntime.CalculateCost(provider, model, usage)`。对既有 `stream-assembler.ts` / `sse.ts` 为最小向后兼容增补（90 条既有测试全绿）；`src/types/*` 与 `providers/deepseek/*` 未动。
- **未完成门槛：** 无（本卡范围）。DeepSeek adapter 尚未把 cost 函数接入其 `sseToModelEvents` 调用（接缝已留；adapter 只绑定 model id，cost 需要 provider，属宿主/后续接线步骤）。retry/timeout 为 P3 卡 5。

## P4.2 交接（1c08756）

- **交付：** `packages/coding-agent/src/core/tools/`（`glob-matcher.ts` `globToRegex` / `globIsMatch`、`enumerate.ts` `enumerateFiles` async generator + `isExcludedDirectoryName`、`glob.ts` `createGlobTool` / `GLOB_DEFAULT_LIMIT`(200) / `GLOB_DEFAULT_SCAN_BUDGET_MS`(60s) / `GlobToolOptions`）从 `src/index.ts` 导出；48 个新测试（`glob-matcher.test.ts` 15 + `glob.test.ts` 33）+ 回归（162 = 114 + 48，161 pass + 1 win-symlink 跳过）。
- **匹配器（精确移植）：** `*`→`[^/]*`、`?`→`[^/]`、`**`→`.*`、`**/`→`(?:.*/)?`（零或多目录，`**/*.cs` 命中根文件）、模式 `\`→`/` 归一化、字面量 regex 转义、`^…$` 锚定；`i` flag 仅 `win32`（Unicode 大小写折叠，非 locale 敏感）。C# `GlobMatcherTests` 全部 15 例 + 边界通过。忽略目录集精确对齐 `ToolHelpers.ExcludedDirectoryNames`（obj/bin/node_modules/.git/.hg/.svn/.vs/.idea/__pycache__/.venv/venv/AppData/Temp/cache/Caches/.cache，全小写，不区分大小写）——TDD 中修掉混合大小写 bug。
- **遍历（P4 gate：真异步可取消）：** `async function*`，每目录 `readdir(dir,{withFileTypes:true})` await + loop-top / readdir 后 / 每文件三处 `signal?.throwIfAborted()`，绝非同步扫描包 Promise；不可读/消失目录跳过（不使遍历失败）；符号链接/交接点目录不下降（Node 将交接点报为 symlink dirent；`stat` 跟随分类——文件链接产出、目录链接跳过、断链跳过）；根恒遍历。扫描预算 60s（可注入），每文件墙钟检查，耗尽返回部分结果 + "扫描超过 N 秒预算…" 显式提示（绝不伪"无匹配"）。结果上限默认 200（可注入，`Math.max(1, limit)`），续传提示 `limit=2N`。空扫描返回 C# 标记 `（未找到匹配文件）`。预期失败为 `error:` 观察；硬中止传播 AbortError（非错误观察）。
- **Windows 路径证据：** 交接点环测试本机通过（不下降、不挂起）；反斜杠模式 `src\*.cs` 归一化命中、结果恒用 `/`；大小写不敏感匹配本机绿；Unicode 文件名（`报告.md`）命中。
- **未完成门槛：** 无（本卡范围）。Windows 文件符号链接创建需管理员/开发者模式（EPERM）→ symlink-file 用例本机跳过、POSIX CI 运行，非卡 gate 失败。文档化小差异：含 Windows 非法字符的 `path` 参数（如 `?`）——C# `Path.GetFullPath` 抛 → `error: 路径参数非法`，Node `resolve` 透传 → ENOENT → `error: 目录不存在`；NUL（常见情况）仍如 C# 走 `路径参数非法`。grep/regex 为 P4 卡 3（复用 `enumerateFiles` / `isExcludedDirectoryName`，worker_threads + `worker.terminate()` 超时终止，100 匹配默认上限，60s 扫描预算）。

## P3.5 交接（bf48fdb、0394c41）

- **交付：** `packages/ai/src/retry/`（`policy.ts` `RetryPolicyOptions` / `RETRY_DEFAULTS`（C# 默认：maxAttempts 3、initialBackoffMs 500、maxBackoffMs 30_000、backoffMultiplier 2、jitterRatio ±0.2）/ `resolveRetryOptions` / `isRetryableFailure`（镜像 C# `LlmException.IsRetryable`：408/429/5xx + `TIMEOUT`/`CONNECTION`/`RATE_LIMITED`）/ `failureOf`（provider 中立 `LlmFailure` 提取）/ `isRetryableError`（SseStreamError `connection`/`timeout` 可重试、`aborted` 不重试）/ `retryDelayMs`（Retry-After 优先，否则指数退避，均封顶 maxBackoffMs，±抖动）；`retrying-model.ts` `RetryingChatModel implements ChatModel`（首 ModelEvent 边界、取消不重试、abort-aware 无泄漏 `defaultRetrySleep`、可注入 sleep）；`index.ts`）从 `@di/ai` 公开导出；27 个新测试 + 回归（150/150）。
- **对既有文件的必要增补（向后兼容）：** `providers/deepseek/adapter.ts` 新增 `headerTimeoutMs`（默认 60s）——`fetchWithHeaderTimeout` 用 linked-AbortController 与 fetch 竞速，header-wait 超时 → `DeepSeekError TIMEOUT`（可重试；**非**总时长超时）；fetch 层网络失败现映射 `DeepSeekError CONNECTION`（原裸 `TypeError`，是"连接中断可重试"红测要求的）；调用方 abort 原样重抛 `AbortError`。`translator.ts` 增 `deepSeekDefaults.requestTimeoutSeconds: 60`。`src/index.ts` 增公开导出。
- **覆盖场景：** 429 + Retry-After（delta 秒 / HTTP-date）→ 按 `providerRetryAfterMs` 等待后重试；Retry-After 封顶 maxBackoffMs（恶意头不拖住回合）；指数退避 `initial*multiplier^(attempt-1)` ±20% 抖动（可注入 random）；有界重试（maxAttempts 含首试，1=不重试）；header-wait 超时可重试；SSE idle `timeout` / 中途 EOF `connection` 可重试；**取消绝不重试**（已 abort 快速失败、attempt 中途 abort、等待期 abort → `SseStreamError "aborted"` / 裸 AbortError）；**首 ModelEvent 边界**：任一 delta 已交付后中途失败直接重抛，消费者恰见一个前缀（逐字节断言无重放）；**无工具重放 gate**：已交付 `toolCallDelta` 阻止重试（attempts===1；架构边界——工具在 loop 执行，绝不在 transport，wrapper 只在任何事件前重发流）；非可重试（401/403/400/UNSUPPORTED_OPTION）不重试；调用方取消优先于 header timer。
- **设计决策：** 重试边界=首 ModelEvent——保持 C# `RetryingChatModel` 策略但修复其中途重枚举缺陷（可能重放已发布前缀），对齐 models-and-auth.md §重试边界。provider 中立：`isRetryableError`/`failureOf` 识别 SseStreamError 码 + 任何携带 `LlmFailure` 的错误，不直接依赖 DeepSeek 模块。header-wait 超时放 adapter 而非 wrapper（wrapper 级竞速=总请求超时，文档明确禁止）。取消表示为 `SseStreamError("aborted")`（与 sse.ts 一致）；loop 已传播任何模型流 rejection，无需改 loop。
- **并行干扰记录：** 根 `npm test` 退出 1 仅因 @di/coding-agent 在途 P4.3 的 grep 红测（37fd82f 中途提交）；@di/ai 150/150 与 @di/agent 50/50 干净。中途出现的 @di/coding-agent TS7006 由并行的 P4.3 agent 修复。未运行真实 API 测试（全部 scripted fetch / loopback）。
- **未完成门槛：** 无（本卡范围）。P3 阶段全部完成（@di/ai 全包完成）。P3.4 的 cost resolver 仍未接入 DeepSeek adapter（宿主接线步骤，P3.4 交接已记录）。后续卡：P4.4 输出收集（P4.3 grep 在途）。

## P4.3 交接（37fd82f、6e32deb）

- **交付：** `packages/coding-agent/src/core/tools/`（`grep.ts` 工具 + worker pool、`regex-worker.ts` worker 脚本）从 `src/index.ts` 导出；45 个新测试（`test/grep.test.ts`）+ 回归（207 = 162 + 45，206 pass + 1 win-symlink 平台跳过）。对既有文件最小增补并导出：`args.ts` +`getOptionalBool`、`glob.ts` +`formatScanSeconds`、`read.ts` +`splitLines`/`resolveOemDecoder`、`tools/index.ts` 与 `src/index.ts` 新导出。复用 P4.2 `enumerateFiles`/`isExcludedDirectoryName`，无重复遍历/分行逻辑。
- **平台终止证据（Windows 实测）：** 灾难回溯 `(x+x+)+y` 对 30 个 x（JS 需 >10s、C# 基线亦挂起）→ `elapsed_ms=560.0`、`isError=false`，输出命中 +「[1 个文件正则匹配超时（单文件超过 0.5 秒）已终止并跳过（如 "bad.txt"）…]」，worker 重建后后续文件仍匹配（套内用例 577.96ms）；挂起正则期间 abort → `rejects with AbortError (304.65ms)`（worker 已终止，rejection 为 AbortError 非错误观察）；扫描中 abort（872ms）；扫描预算部分结果。
- **覆盖场景：** 移植 C# `GrepToolTests.cs` 32 例（`rel:line: text` 格式、每文件行号、glob 过滤、path 作用域、默认大小写敏感、`（未找到匹配）` 标记、非法正则/缺 pattern/非法 JSON/路径不存在/路径为文件错误、二进制 NUL 文件、超大文件跳过 + 诚实提示 + 总数与 3 名样本、100 上限提示、EOF 无换行、空文件、中文内容、CRLF 剥离、500 字符截断、`ignore_case`/`literal`/`context`/`limit` 提示、`^…$`、alternation、pre-aborted abort、abort-during-scan、scan-budget 提示）+ TS 特有：`ignore_case` 大小写不敏感、中文 UTF-8、`\p{L}+`（u flag）、**GBK/OEM-936 内容**经 `TextDecoder("gbk")` 解码匹配（对照 .NET `GetEncoding(936)`）、`\A`/`\z` 桥接 `^`/`$`、.NET 独有语法显式 `error:` 观察、`^$` 无幻影尾空行、UTF-8 BOM 剥离、context 重叠去重（C# `ScanWithContext` 语义）、`limit:0` clamp、非法 `context`/`ignore_case`/`literal` 类型错误观察。
- **设计决策：** 1) 每 grep 调用一个常驻 worker、跨文件复用，超时/中止后 terminate 重建（避免探针测得 ~40ms/文件 spawn 成本；探针 `worker.terminate()` 5ms 杀进程证据为安全边界）。abort 以 `signal.reason`（AbortError）reject，绝不转错误观察；单文件 job 超时（默认 10s 可注入）嵌在 60s 扫描预算内（每文件检查）——相对 C#（无正则超时）是新增安全边界。2) 恒设 `u` flag：`\p{…}` 可用，.NET identity 转义（`\A`/`\z`/`\Z`/`\R`/`\p`）绝不静默当字面量；`\A`/`\z`/`\Z` 桥接 `^`/`$`（每行无换行，安全）。3) JS 拒绝的 .NET 独有语法（单引号命名组、balanced/conditional 组、`\p{IsScript}`）→ 显式 `error: 无效正则表达式: …`，绝不静默空结果。4) 文件内容解码同 read_file（P4.1/P4.2）：先 strict UTF-8（剥 BOM），再系统 OEM；不可解码文件跳过 + 提示，绝不静默乱码。5) 空标记用 C# `Core/Tools/GrepTool.cs` @09f4e08 的「（未找到匹配）」（任务卡写的「（未找到匹配文件）」是 glob 的标记——记录此差异，两者均含「未找到」且 C# 测试按其断言）。6) 正则超时与解码跳过**抑制**「no match」标记，带样本名 + 可行动提示（对齐 C# 超大跳过规则，绝不把跳过冒充无匹配）。
- **已知差异 / 未过门槛（grep.ts 头注释记录）：** JS `\w`/`\d`/`\b` 即使 `u` 下仅 ASCII（异于 .NET Unicode 版）——探针的 Unicode 翻译层未在本卡实现，conformance 矩阵的 Unicode shorthand 项未验证；`\p{Is<Script>}` 需 JS `\p{Script=…}`（现显式 error）；字符类内锚翻译（`[\A]`）未处理（罕见边）；变长 lookbehind / atomic 组取决于固定 Node 版本（探针 §待复核）。完整冻结 conformance 矩阵 + 跨平台 fixtures 是单独阶段 gate，非本卡。
- **并行干扰记录：** P3.5（@di/ai retry/timeout）并行提交 `0394c41`/`cbf1a66`，全程无 broken dist；最终 @di/ai（150）与 @di/agent（50）测试干净。
- **未完成门槛：** 无（本卡范围）。后续卡：P4.4 输出收集（有界 stdout/stderr 环形缓冲，接入进程 runner / one-shot shell，依赖 P4-win-process-probe 的 Windows 进程树 kill 结论）。

## P2.5 交接（5ddcf92、b9d584a）

- **交付：** `packages/agent/src/agent-loop.ts` 的 `emit` 改为 try/catch 包住 `await dependencies.events?.(event)`：sink 抛错/rejection 时 catch，按序 `await dependencies.onObserverError?.(error, event)`，其自身同步抛错 / Promise rejection 再内层 catch 吞掉（绝不产生未处理 rejection）；`onObserverError` 只在 sink 抛错时调用（sink 未提供时 `await undefined` 不触发 catch）。保持逐事件 `await` 的顺序语义，未改成 fire-and-forget。checkpoint 调用点（`appendMessage` / `toolStarted` / `toolCompleted`）原样不动，fail-closed 策略保持。`src/index.ts` / `agent-loop.ts` 头注释更新。测试 `packages/agent/test/agent-loop.test.ts` 新增 5 条（P2.4 回归 45 + 新 5 = 50）：sink 在 turnCompleted(1) 抛错 → 已授权工具仍执行、stopReason=answer 不变、后续事件仍按序发出、onObserverError 恰一次收到 (error, turnCompleted(1))；sink 每次抛错 → loop 存活、onObserverError 按序收到全部 4 个事件；onObserverError 自身抛错 → 吞掉、loop 继续、无未处理 rejection（node:test runner 以未处理 rejection 判测试失败，run 干净 resolve 即为证据）；checkpoint.appendMessage 抛错 → run 以该错误 rejection、工具零执行、model 仅 1 次调用；checkpoint.toolCompleted 抛错 → 工具已执行但 run 以该错误 rejection、无下一次模型调用（fail-closed 确认）。
- **红→绿：** 红为 `npm test -w @di/agent` 退出 1（50 中 3 失败 = 全部 observer 隔离用例：`Error: observer boom` 自 `emit`（dist/agent-loop.js:241）传播使 runAgentLoop rejection、工具不执行；2 条 checkpoint fail-closed 确认用例已实现直接绿）。实现后绿：build(0)、test(0, 50/50)、typecheck -w(0)；根 typecheck(0，P3.5/P4.3 在途当前 typecheck-clean)；TUI test(0, 116 pass)、TUI build(0)。
- **设计决策：** observer 是观测旁路、非控制面：`events` 失败不中断 loop、不阻止已授权工具、不把成功回合变失败；checkpoint 是控制面：写前意图 / 结果失败原样中止（intent-write-before-execution，未写入的 intent 工具绝不执行；结果 checkpoint 失败不发起下一次模型调用）。两者错误策略相反，用同场景独立用例分开锁定。`onObserverError` 只在 sink 抛错时调用——正常路径零额外开销，对齐 C# `_ = _eventBus?.PublishAsync(evt)` 的"坏订阅者不拖垮 loop"，但 TS 用 await+catch 同时保证顺序与隔离。`emit` 未改模型流接口，`streamModel` 的 delta 转发路径同样受益。
- **并行干扰记录：** P3.5（@di/ai retry）与 P4.3（@di/coding-agent grep）在途；本卡全程根 `npm run typecheck` 干净（0），未遇 @di/ai dist 破损；若后续再遇 `@di/ai` import 报 ERR_MODULE_NOT_FOUND / SyntaxError，属 P3.5 在途重建状态，按 P2.3 先例用提交态 src 重建 dist（`npm run build -w @di/ai`）后重试，不编辑 P3.5 的 src。
- **未完成门槛：** 无（本卡范围）。历史 / 快照 / budget tracker、模型切换均为后续 P2 卡。

## 下一张任务卡（P2 第六个单元：跨回合历史、快照与 budget tracker）

- **ID：** P2.6-history-budget
- **输入：** `@di/coding-agent` 的 `AgentSession`（若骨架尚缺，本卡先建最小 `runTurn` 入口并复用 `@di/agent.runAgentLoop`）；C# 基线 `Core/AgentLoop/AgentRunner.cs`（`RunAsync`、`TrimHistoryByTokens`、`SanitizeHistory`）；权威：loop-and-state.md §"AgentSession 历史与恢复"、§"中断、取消与并发生命周期"、§"iteration 与停止理由" 与"逐单元红绿实施与验收边界"表的 agent-session / history / recovery / budget 行。所有权：跨回合 history、model/skills、budget tracker、checkpoint/recovery、stop controller 只在 `AgentSession`（host），`runAgentLoop` 保持纯 loop 不保存下轮历史。
- **行为：** `AgentSession.runTurn` 是唯一 session turn 入口，同一 session 串行化（并发 prompt 返回 busy 拒绝、`resetHistory` 仅无 running turn 时生效，不允许并发清空在用数组）；每轮把完整 trajectory 加入跨回合 history，再按估算预算丢最旧整 user-turn（保留最近一轮），保存前只修整尾端不配齐工具组（`SanitizeHistory`，结果 trajectory 不改写）；`ContextLimit` 返回 `context_limit` 后置位 `preserveHistoryUntilReset`，下一轮不得自动裁剪该暂停轨迹 / 生成摘要；model / skills 修改在 turn 边界生效；stable system prompt 快照只在变更时追加为 history system message（不重复注入稳定字节前缀）；budget tracker 反馈估算值（非 billed usage），工具执行前可见本轮已累积 assistant/tool trajectory，回合末同步裁剪后 memory 的估算值；无 model window 时不发明 token 限制（`maxHistoryTurns` 仅显式正数且无 token budget 时兜底）。
- **范围：** `packages/coding-agent/src/` 与 `packages/coding-agent/test/`（AgentSession 及 history/budget helper 文件）；不改 `@di/agent` / `@di/ai` 既有类型与行为。注意 P4.3（grep/regex）可能仍在 `packages/coding-agent` 并行改动，务必 `git add` 只加本卡文件、先 `git status --short` 核对。
- **红测：** `packages/coding-agent/test/agent-session.test.ts` 新用例（红为断言失败，非路径/缺依赖错误）：回合 A 的 trajectory 出现在回合 B 的 history（跨回合 memory）；整 user-turn trim 保留最近一轮；未配齐 tool calls 在持久 history 中 sanitize（结果 trajectory 不被改写）；ContextLimit 之后下一轮不 trim（preserve 标志生效）；stable snapshot 只变更时追加；并发 prompt/reset 按 busy 策略拒绝；budget tracker 工具执行前看到本轮已累积 trajectory、回合末看到裁剪后估算。
- **实现：** 最小 `AgentSession`：`runTurn(request, deps, signal)` → 每次调 `runAgentLoop`，回合后把 trajectory 并入 history 再 trim/sanitize；`resetHistory` 仅无 running turn 时生效；turn 边界切换 model/skills；budget tracker 为纯 helper（估算值进、裁剪 memory 估算值出），无 Node Buffer/文件 API 依赖。工具执行先复用 P4 的 `createToolExecutor` 或注入假 executor，不等待真实 shell。
- **绿测：** `npm run build -w @di/coding-agent`(0)、`npm test -w @di/coding-agent`(0, 既有回归 + 新用例)、`npm run typecheck -w @di/coding-agent`(0)；根 `npm run typecheck`；`npm.cmd --prefix tui test`（116 pass）与 `npm.cmd --prefix tui run build`。
- **后续卡（按 operator-guide P2 顺序）：** 模型切换 → P2 完成后进入 P5 依赖（或并行 P3/P4 剩余卡）。
