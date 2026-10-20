# TypeScript Core 迁移：进度表

> **状态：P0 与 P1.1 已完成（本文件由 P0 提交创建，P1.1 由迁移单元更新）。** 只保存简短状态表与证据位置，不复制专题契约；
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
| P1 最小工作区、词汇和夹具 | P0 | in_progress | P1.1 完成 / P1.2 未开始（见子行） | 见 P1.1 行 | P1.2 未执行 |
| P1.1 根 workspace、@di/ai 词汇与假模型无工具答案红→绿 | P0 | **verified** | 见本单元交接（`git log -1`） | `npm install`(0)；红测 `npm test -w @di/ai`(1, ERR_MODULE_NOT_FOUND)；绿测 `npm test -w @di/ai`(0, 1 pass)；`npm run build`(0)；`npm run typecheck`(0)；`npm.cmd --prefix tui test`(0, 116 pass)；`npm.cmd --prefix tui run build`(0) | 无 |
| P1.2 记录型假执行器与跨语言 fixtures | P1.1 | todo | – | 未执行 | 无 |
| P2 纯循环与宿主状态 | P1 | todo | – | 未执行 | 无 |
| P3 通用模型与 DeepSeek | P1 | todo | – | 未执行 | 无 |
| P4 八个工具与平台执行 | P1 | todo | – | 未执行 | 预研已完成（27e3e60）；工具实现未开始 |
| P5 检查点、恢复和统计 | P2, P4 | todo | – | 未执行 | 无 |
| P6 Skills、配置、命令和日志 | P1 | todo | – | 未执行 | 无 |
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

## 下一张任务卡（P1.2）

- **ID：** P1-2-recording-executor-and-fixtures（示例编号，由实施者确认）
- **输入：** 记录型假执行器（`@di/agent` 的 `ToolExecutor`/`ToolObservation` 形状）与首组跨语言合成 fixtures（纯答案 / 工具往返 / 错误 / 软停 / 硬取消 / 预算暂停 / 恢复的最小样例）；契约见 execution-plan P1 §5、loop-and-state.md §"建议公开的最小 loop types"、architecture.md 依赖方向。
- **前置：** P1.1（本单元）已完成——根 workspace、`@di/ai` 词汇、假模型无工具答案测试已 green，TUI 116 测试不退化。
- **红测：** 先写使用记录型假执行器的业务测试，运行确认因缺失行为失败（red），再补最小实现（green）。
- **保留：** 原 `tui/` 路径与包名；不处理 `tui/package-lock.json`。
- **约束：** ESM / strict / `noUncheckedIndexedAccess` / erasable TS / `node:test`；跨包从公开 `exports` 导入；生产包编译后运行；脚本兼容 Windows（不依赖 POSIX glob）。
- **门槛：** 干净环境能安装、检查类型并通过首个真实 TS 用例；TUI 原测试（116 项）不退化。
