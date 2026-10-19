# Core 迁移执行顺序与任务卡

> **状态：待实施。** 入口与基线见 [docs/migration/typescript-core/README.md](README.md)。本文件的 TS 产物 / scripts 均未创建。
> 完整模块映射和共用接口只在 [architecture.md](architecture.md) 维护；循环、模型、工具和恢复分别由对应叶子文档定义。

## 1. 依赖顺序与协作

```text
P0 参考与行为清单 → P1 工具链/词汇/夹具 → P2 纯循环
                                         ├→ P3 DeepSeek/通用模型
                                         ├→ P4 工具/进程
                                         ├→ P5 检查点/恢复（完成需P2/P4）
                                         └→ P6 Skills/配置/命令/日志
P3 + P4 + P5 + P6 → P7 TS宿主/RPC/原TUI
P3 + 凭据存储接口 → P8 ChatGPT认证/Responses
P7 + P8 → P9 本地Runner/全量验收/发布回退
```

P1 只建最小可运行环境，P2 先用假模型 / 假工具跑通，不一开始建空壳框架。P3 / P4 / P6 可以并行；共用类型、根依赖和锁文件由一个集成者维护，其他 AI 先交接接口再写实现。不可切换共享工作区分支模拟隔离。

每个单元都要有 red → green 证据及包级检查，完成后提交一个英文 Conventional Commit，不带 attribution trailer。没有运行测试要如实记录，不能写“应当通过”。旧缺陷和有意变化按入口文档记录，不通过改断言掩盖差异。

## P0 冻结参考与行为清单

**输入：** Di `09f4e08`、固定 Pi 提交、根 `AGENTS.md`、本目录全部文档。

1. 运行 `git status --short`、`git branch --show-current`、`git rev-parse HEAD`，确认迁移分支和用户改动所有权；不清理、不 reset 用户内容。
2. 运行 `git cat-file -t 09f4e08`；查旧源码用 `git show 09f4e08:<path>`。需要跑旧版时使用隔离 checkout / 构建产物，不把当前工作区切回旧分支。
3. 对照 Pi 的固定提交阅读相应模块；不安装、不构建、不复制全仓库。记录采用哪些职责边界、不采用哪些功能。
4. 按源代码与测试建立行为台账：旧源码、旧测试、目标任务、新测试、完成门槛。完整路径映射引用架构文档，不在台账再定义一套。
5. 在独立临时 `DI_HOME` 下跑基线非集成测试，记录平台 / 运行时 / 已知环境失败，不读取真实凭据。

**门槛：** 参考可读取，测试基线明确，关键行为有对应任务。之前 943 项 .NET 非集成 / 116 项 TUI 测试只是一次验收快照，不是未来等价性的充分条件。

**禁止：** 覆盖安装版、改用户配置、删 C# / 难迁测试、切旧分支写迁移代码。

## P1 最小工作区、词汇和夹具

**待创建：** 根 npm workspaces / 根锁文件、三个目标包 manifests / TS 配置、假模型、记录型假执行器、跨语言合成 fixtures；目录与接口按架构文档。

1. 先写导入 `@di/ai` 并通过假模型返回无工具答案的测试，运行确认因缺失行为失败，再补最小实现。
2. 保留原 `tui/` 路径和包名，首期沿用已核实版本；根锁文件验证可重现后再处理 `tui/package-lock.json`，不先删旧锁。
3. ESM / strict / `noUncheckedIndexedAccess` / 可擦除 TS 语法；用 `node:test`。跨包从公开 `exports` 导入，生产包编译后运行；不越包引用对方私有 `src`。
4. 在最低 Node 和本机 Node 跑类型 / 测试。测试发现脚本要兼容 Windows，不依赖 POSIX glob；脚本实际创建后才能运行。
5. 提取纯答案、工具往返、错误、软停止、硬取消、预算暂停、恢复的最小 fixture。两实现共享输入与预期，不为 TS 单独降低标准。

**门槛：** 干净环境能安装、检查类型并通过首个真实 TS 用例；TUI 原测试不退化。空包 / 未实现异常不算迁移完成。

## P2 纯循环与宿主状态接缝

**源：** `Core/AgentLoop/ReAct.cs` 的 `RunCoreAsync`、`Core/AgentLoop/AgentRunner.cs` 的 `RunAsync` / `RestoreHistory` / `ResetHistory`、`Core/AgentLoop/AgentRequest.cs`、`Core/AgentLoop/AgentResult.cs`。

按 [loop-and-state.md](loop-and-state.md) 分单元先测再实现：消息良构与最终响应、默认不限轮数与显式预算、所有停止原因、软停止 / 硬取消、工具批边界、事件异常隔离、历史与快照、完整请求预算、`ContextLimit` 锁存、模型切换。估算 helper 不能让纯 agent 引入 Node fs / Buffer 等宿主依赖，可注入或用无 Node 依赖实现。

单 session 的回合必须互斥，忙碌时 clear / 新 prompt / 切模型的行为需明确且可测。观察事件允许异常隔离；持久化 checkpoint 必须被等待，禁止通过 fire-and-forget 总线保存关键 intent。

**门槛：** 假模型 256 次工具往返、取消、计量、事件顺序通过；纯循环测试无需磁盘、凭据和 TUI。

## P3 通用模型与 DeepSeek

按 [models-and-auth.md](models-and-auth.md) 实现消息翻译、流装配、错误 / 重试 / 用量和 DeepSeek，先用本地 HTTP/SSE server。

**红测：** 分段 / 合并 chunk、多字节、参数碎片、缺终态、响应头 / idle 超时、连接中断、Retry-After、取消不重试、未知成本 / 缓存不伪造为零。

**门槛：** 请求的稳定 system、完整 history、易变 skill 顺序以及 reasoning / 缓存字段与基线样例一致；HTTP 重试不会重放已经执行的工具。

## P4 八个工具与平台执行

按 [tools-and-platform.md](tools-and-platform.md) 先文件工具、再搜索、再进程与持久 shell。先实现进程树终止和输出排空，再接 cmd/bash、PowerShell、Python。

**门槛：** Windows 中文 / UTF-8 混合输出、头尾截断固定内存、管道遗留、进程树超时 / 取消、shell 状态 / 自愈、扫描预算与取消、路径 / 换行均实测。不能以“返回 Promise 的同步扫描”代替异步可取消执行。

## P5 检查点、恢复和统计

按 [sessions-and-compatibility.md](sessions-and-compatibility.md) 实施，格式不在此重复定义。

**红测：** intent 写失败零执行；完整结果与完成标记同行；各边界截断；started 无结果拒绝；部分批次完成；同 ID 跨批次；尾行 / 内部坏行；旧日志拒绝；模型异常后同进程继续；暂停后扩预算继续；clear 不复活；`--no-session` 不产生日志。

**门槛：** 约定兼容格式双方互读；真实 TS CLI 强制终止再恢复保留结果、不由宿主重放副作用；累计快照不会重复统计，未知字段不伪造已知。

## P6 Skills、配置、命令和日志

本节给出尚未由其它迁移叶子规范覆盖的任务。现状见实际源码及 `docs/modules/skills.md`、`docs/modules/logging.md`、`docs/di-home.md`、`docs/cli.md`。

### P6.1 配置与资源路径

**源：** `Core/Configuration/DiHome.cs` 的 `Resolve` / `ProjectConfigFile`、`Di.Cli/DiConfig.cs` 的 `Load`、`Di.Cli/CliHost.cs` 的 `Create`。测试 `Di.Cli.Tests/Configuration/DiConfigTests.cs`。

**未来目标：** `packages/coding-agent/src/core/config/`；显式注入工作区、家目录、环境、默认值，纯解析与资源写入分开。

逐项先测再实现：

- `DI_HOME` 空白回退、不同根目录、相对 / 绝对路径；用户配置不创建、不覆盖。
- 默认 → 用户 → 项目 → 环境变量优先级，逐键合并嵌套配置；不能用浅层对象展开替代。`__` 层级键、键大小写、未知键、数字 / 布尔 / 空值都提取兼容 fixture。
- 当前 `appsettings.json` 允许注释；采用 JSONC parser 必须固定版本和测试，不能用正则删注释或直接严格 JSON.parse 导致启动失败。
- 程序写 sessions、logs、artifacts 和权限受控 auth；不要把旧文档“只写 sessions”的过时简述当事实。
- 开发检出、编译后的 npm 包、任意 CWD 下资源定位一致；`process.cwd()` 不是包安装目录。

**门槛：** 同 fixture 下生效配置相同，加载不要求凭据；`--info` 如实报告实际入口 / 来源 / 默认不限轮数。

### P6.2 Skills

**源：** `Core/Skills/SkillMarkdown.cs`、`SkillRepository.cs`、`SkillLocations.cs`、`SkillMatcher.cs`、`SkillActivation.cs`、`SkillContext.cs`、`SkillTools.cs`。目标为未来 `packages/coding-agent/src/core/skills/`；现有测试在 `Di.Tests/Skills/`。

| 单元 | 必须先建立的行为样例 |
|---|---|
| frontmatter | 受识别键重复拒绝、未知字段忽略、名称与文件一致、BOM/CRLF、支持格式不因换 YAML 库无意变化 |
| 来源顺序 | 用户 `.agents/skills` → 用户 `.di/skills` → 项目祖先 `.agents/skills` 远到近 → 当前项目 `.di/skills`；`.git` 文件 / 目录均为根 |
| 同源冲突 | 目录式先、扁平式后、同名有警告、坏文件跳过、遍历顺序确定 |
| 匹配 | ASCII 分词 / 停用词、中文二元组、重叠系数、阈值 0.30、最多 3 个；同分名称 Ordinal 排序，非 locale 排序 |
| 激活 | pinned 在前、auto 去重且每轮重算；disable-model-invocation 不广告 / 自动匹配但仍接受显式调用 |
| 披露 | 广告与激活正文分开，正文进入易变系统上下文；load_skill 附目录提示，不污染持久历史 |
| 元数据 | allowed-tools 目前不是已经实施的权限约束，不能宣称沙盒化 |

**门槛：** 相同消息在 REPL / print / JSON / RPC 激活集一致；固定激活与一次性带参数执行都保留。

### P6.3 命令、模型选择与 CLI 模式

**源：** `Di.Cli/Commands/` 的 `SlashCommandRegistry` / `BuiltinCommands` / `CommandMarkdown` / `CommandLoader`，`Di.Cli/ModelSelection.cs`，`Di.Cli/cli/CliArgs.cs` / `CliMode.cs` / `CliInfo.cs`，`Di.Cli/CliApp.cs`。

**未来目标：** `packages/coding-agent/src/core/commands/`、`src/core/model-selection.ts`、`src/cli/`、`src/modes/`。

1. 内置 `/exit`、`/help`、`/clear`、`/model`、`/thinking`、`/usage`、`/skills`、`/skill`；注册表生成帮助 / 补全，各模式共用 handler。
2. 用户 commands Markdown 的名称 / 元数据 / 重复警告 / 参数拼接 / 回合型命令；RPC 的 turn_not_supported 与 turn_message 仍由现有 TUI 接续，不偷偷开第二回合。
3. provider/model、唯一 ID、唯一片段匹配、歧义、刷新失败保留快照；切换失败不改模型，跨 provider 成功重置推理档位，忙碌时拒绝切换。
4. `--`、别名、缺值、未知旗标、TTY / stdin、version/info/help/list-models/stats/skill-eval、auth chatgpt；按 `CliMode.Resolve` 迁模式优先级，不只实现 prompt。
5. `--resume` 无显式模式和提示词时进入简单交互，不自动请求模型；位置参数或显式模式优先；恢复失败不伪装空会话。
6. stdout / stderr、ANSI、JSON 单文档、RPC NDJSON、退出码与 stop reason 以兼容文档为准，内部 camelCase 不直接出线。

**测试：** `Di.Cli.Tests/Commands/`、`Di.Cli.Tests/ModelSelectionTests.cs`、`Di.Cli.Tests/cli/`、`Di.Cli.Tests/modes/PrintModeTests.cs`、`Di.Cli.Tests/modes/RpcModeTests.cs`。

### P6.4 运行日志

**源：** `Core/Logging/DiLog.cs` 的 `Subscribe` / `Log` / `Dispose`、`Core/Logging/DiLogOptions.cs`、`Core/Tools/ProcessDiagnostics.cs`；测试 `Di.Tests/Logging/DiLogTests.cs`。

**未来目标：** `packages/coding-agent/src/core/logging/`。验证本地时区、按日轮转、字段折叠 / 截断、生命周期一事件一行、逐字流不写运行日志、慢进程 / 超时诊断、退出关闭。

运行观察日志 I/O 失败不影响主流程；checkpoint 失败必须阻止未开始副作用，不能共用一个吞异常写入 helper。禁止 token/Authorization/Cookie 进入日志；JSON 模式 stdout 不得混日志。普通 flush 不等于任意掉电事务保证。

## P7 TS 宿主 / RPC / 现有 TUI

先组装真实 `AgentSession`，再接 print/json/rpc；假 Runner 协议测试与实际宿主联调都要有。

- 原 `tui/src/rpc/codec.ts` 能读 TS 输出：ready、事件、命令、终态、错误、shutdown/EOF。
- `tui/src/rpc/client.ts` 允许注入 TS 启动器；Windows npm `.cmd` shim 不可当原生 exe 直接 spawn，开发期可指定 `process.execPath` 加编译后入口参数。
- 复用 `tui/src/app/`，只调整启动 / 依赖注入接缝，不搬目录、不重画界面。
- 测试消费开始 / 排空、终态恰好一次、busy 行为、stdout 协议隔离、后端异常退出清理。

**门槛：** TUI 原测试继续通过，相同合成任务在两后端有同等可观察行为，启动 / 取消 / 模型故障可诊断。

## P8 ChatGPT

按模型文档完成 OAuth/PKCE、权限范围、凭据锁 / 刷新事务、原始 output / reasoning 回放、目录 / 推理档位 / 用量未知值。

**门槛：** 合成端点下认证 / 并发刷新 / 失败路径通过；两 provider 切换、较小窗口、缺凭据 / 无网络不会破坏状态。未做真实账号 smoke 要如实记录，不能冒称订阅端到端已验证。

## P9 本地 Runner、切换与完成

按 [validation-and-release.md](validation-and-release.md) 的完整门槛执行：在原 TUI 接缝加入本地 Runner、同事件 / 状态机验收、保留外部 RPC、独立命令与安装目录试运行、用户数据兼容、实际支持平台安装与回退演练。

迁移中的 shim 不抢占已安装 `di`，原日志不就地改写；C# 生产依赖退出及源码清理单独提交，原分支和基线保留。只有干净安装、契约差分、关键故障恢复、原 TUI 保持、文档权威切到 TS、回退均通过，才标记迁移完成。

## 2. 失败处理与交接

| 失败 | 必须做 | 不可做 |
|---|---|---|
| 类型 / 依赖 | 读真实声明、固定版本、缩小到包 | 全局 any、跳检查、盲升依赖 |
| 差分不一致 | 保留两侧输出，定位翻译 / 状态 / 旧缺陷 | 抹去 stop reason / call id / 参数 / 顺序 |
| 取消挂起 | 查进程树和管道，断言清理时限 | 任意放大超时、遗留进程 |
| 恢复未知 | 保留证据并拒绝重放 | 删除 started、伪造成功结果 |
| 平台失败 | 保留具体复现与修复 | Linux 通过就宣称 Windows 等价 |
| 测试减少 | 说明合并 / 数据化后的覆盖关系 | 仅比较数量或删除困难用例 |

交接说明至少包括任务编号、当前提交、读过的契约、修改文件、具体完成行为、red 与 green 命令 / 结果、平台 / Node、差异决定、尚未通过的门槛、下一个可执行动作。不要把临时调试流水追加进长期架构文档。
