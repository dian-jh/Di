# TypeScript Core 迁移：进度表

> **状态：P0、P1.1、P1.2 与 P3.1 已完成；P2 / P3.2 / P6.1 进行中（本文件由 P0 提交创建，各迁移单元更新）。** 只保存简短状态表与证据位置，不复制专题契约；
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
| P2 纯循环与宿主状态 | P1 | in_progress | –（P2.1 派发中） | 未执行 | 无 |
| P3 通用模型与 DeepSeek | P1 | in_progress | P3.1（见子行）；P3.2 进行中 | 见 P3.1 子行 | 无 |
| P3.1 provider chunk assembler | P1.1 | **verified** | c0eb1de | 红：`npm test -w @di/ai`(1, 缺 AssemblerError 导出)。绿：`npm run build -w @di/ai`(0)、`npm run typecheck`(0)、`npm test -w @di/ai`(0, 27/27, 含 P1.1 回归) | 无；后续卡：SSE framing（P3.2，进行中） |
| P4 八个工具与平台执行 | P1 | todo | – | 未执行 | 预研已完成（27e3e60）；工具实现未开始（待 P6.1 完成后派 P4.1） |
| P5 检查点、恢复和统计 | P2, P4 | todo | – | 未执行 | 无 |
| P6 Skills、配置、命令和日志 | P1 | in_progress | P6.1 进行中 | 未执行 | 无 |
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

## 下一张任务卡（P2 第一个单元）

- **ID：** P2-loop-pure-answer
- **输入：** `packages/agent/src/`（`types.ts`、`tools.ts`、`agent-loop.ts`）；`@di/ai` 假模型（P1.1）与记录型假执行器（P1.2）；`fixtures/` 的 `kind:"loop"` 样例。
- **行为：** 实现 `runAgentLoop` 的纯文本答案路径（等价 C# `ReAct.RunCoreAsync` 无工具分支）：合成 trajectory、检查软停 / 预算、调用模型、append assistant、发 `turnCompleted`、无工具调用返回 `stopReason=answer`；随后按 loop-and-state.md 逐单元推进工具往返、预算 / 迭代、取消。
- **红测：** 先写 `packages/agent/test/agent-loop.test.ts`，用假模型返回无工具答案，运行确认因缺失行为失败，再补最小实现。
- **绿测：** `npm test -w @di/agent`（含用 recording executor 驱动的 fixture 校验）；`npm run typecheck -w @di/agent`；根 `npm run typecheck`；`npm.cmd --prefix tui test`（116 pass）与 `npm.cmd --prefix tui run build`。
