# Di 功能全景、MVP 评估与工业级路线图

> 设计文档。回答三个问题：
> 1. 本项目已经实现了哪些 harness 功能（能力全景，按模块分篇维护）；
> 2. 作为一个 MVP harness 还缺什么；
> 3. 要走向工业级 harness，下一步做什么、按什么顺序、依托哪些已有接缝。
>
> 配套文档：`docs/README.md`（总索引）、`docs/architecture.md`（架构与关键决策）、
> `docs/cli.md`（CLI 契约）、`docs/di-home.md`（家目录与配置规范）、`docs/interrupt.md`
> （中断语义）、`docs/modules/README.md`（模块索引）。

---

## 1. 一句话定位

Di 是一个**无外部框架依赖的 ReAct coding-agent harness**：模型层（流式优先 + 重试 + 成本核算）→
循环层（ReAct + 事件总线）→ 能力层（8 个内置编码工具 + Skills 渐进式披露）→ 宿主层
（REPL + 会话 JSONL + 分层配置）。核心思想：**一切厂商怪癖收敛在适配器翻译层、模型是纯数据、
认证是声明、循环只发事件不渲染**。

> 规模快照（2026-10-13 复核，`dotnet test`）：**779 个用例全绿**（Di.Tests 563 + Di.Cli.Tests 216；
> 另有 2 个真实 DeepSeek 集成测试 `Di.Tests/Integration/DeepSeekReActIntegrationTests.cs`，
> `SkippableFact`，无 `DEEPSEEK_API_KEY` 时自动跳过）。此统计是**易变快照**，不要当作接口契约。

## 2. 能力全景（按模块分篇维护）

各子系统的"能力 → 代码落点 → 测试落点"表格**唯一定义在对应模块文档**，这里只给入口，不复制内容：

| 子系统 | 文档 | 覆盖能力 |
|---|---|---|
| 核心循环 | `docs/modules/agent-loop.md` | ReAct 主循环、停止条件、迭代预算、跨回合记忆、环境快照、成本累计 |
| 模型层 | `docs/modules/llm.md` | 路由、流式协议、重试、计量、成本、目录、认证 |
| DeepSeek 适配器 | `docs/modules/deepseek.md` | SSE 传输、错误翻译、线格式 5 条怪癖、缓存优化、目录、鉴权 |
| 工具 | `docs/modules/tools.md` | 8 个内置编码工具、注册表与工具集、共享会话、有界输出、Windows 编码 |
| Skills | `docs/modules/skills.md` | SKILL.md 解析、两级发现、词法匹配、渐进式披露、评估 |
| 会话与配置 | `docs/modules/sessions.md` + `docs/di-home.md` | 会话 JSONL、家目录、分层配置、所有权 |
| 事件总线 | `docs/modules/events.md` | push 订阅 + pull 消费、多态派发、异常隔离 |
| CLI / UI | `docs/cli.md` | REPL、流式渲染、斜杠命令、参数 / 模式解析、headless、分发 |
| 中断 | `docs/interrupt.md` | 软停止 / 硬取消 / 退出的递进语义、相位边界状态机、停止契约、各前端接线 |

## 3. MVP 评估

### 3.1 结论

**核心 harness 已达成并超出 MVP，§3 的 5 个可用性缺口已全部补齐**：循环、流式、8 工具、
skills、会话、成本、配置、事件总线、分发、headless、递进式 Ctrl+C（软停止 / 硬取消）、
上下文 token 预算、README——一个编码 agent 该有的骨架全部在，且工程质量高（协议义务化、
错误结构化、模型纯数据、成本可核算）。

MVP 至此收尾。接下来的重心转向工业级路线图（§4）：对会动文件的编码 harness，
**安全与可信（Phase B）是第一道门槛**，其余各阶段都建立在"用户敢让它自己改代码"之上。

| # | 缺口 | 现状 | 为什么算 MVP 缺口 | 建议落点 |
|---|---|---|---|---|
| 1 | **全局命令与分发** | ✅ 已实现：`di.exe`（win-x64 自包含单文件）+ `install.cmd` / `install.ps1` 入 PATH，幂等 | 一个不能被"安装并运行"的 harness 不是 MVP | `Di.Cli/Properties/PublishProfiles/di.pubxml` + 仓库根安装脚本 |
| 2 | **非交互单发模式** | ✅ 已实现：`di "prompt"`、`di --mode json`、stdin 管道、`-m/--provider/--no-session/--no-ansi` | 脚本化、CI、自动化测试都需要 headless | `Di.Cli/CliApp.cs` 分派 + `Di.Cli/modes/PrintMode.cs`；契约见 `cli.md` §4 |
| 3 | **回合级中断（Ctrl+C）** | ✅ 已实现：`Di.Cli/InterruptCoordinator.cs` + `Program.cs` 注册 `CancelKeyPress`；**递进式**——第一次 Ctrl+C **软停止**（在相位边界优雅收敛，正常返回 `StopReason.Interrupted`，保留已写入会话），第二次才硬取消当前回合（杀在途模型流 / 子进程），无回合时退出进程 | 长回合中断应只取消当前回合，保留已写入会话 | `InterruptCoordinator`（实现 `Core.AgentLoop.IInterruptSignal`）+ `ReAct` 的两处相位边界检查；语义见 `docs/interrupt.md` |
| 4 | **上下文 token 预算** | ✅ 已实现：`AgentLoopOptions.HistoryBudgetRatio`（默认 0.5）按当前模型 `ContextWindow` × 比例做跨回合记忆预算，超限丢最旧整回合；未知窗口退回轮数启发式 | 读大文件 / 跑测试可瞬间超窗，10 轮启发式防不住 | `AgentRunner.TrimHistoryByTokens` + `CliHost` 注入的 `contextWindowProvider`（经 `ILlmService.ResolveModelAsync` 取目录窗口） |
| 5 | **README 与上手文档** | ✅ 已实现：README 安装 / 用法 / 配置 + `docs/cli.md` 契约 | 一个要被用的项目必须有"装什么 / 怎么跑 / 怎么配" | 仓库根 `README.md` + `docs/cli.md` |

> 其余未实现项（`/resume`、MCP、子代理、权限审批流、遥测、多 provider、登录命令）
> 都不属于 MVP 必须 —— 它们是工业级范畴，见 §4。
> 命令注册表已提前落地（Phase D 首项，见 §4）：注册表 + 内置命令 + `~/.di/commands/*.md`
> 用户命令，REPL 与 `--mode rpc` 前端共用（`Di.Cli/Commands/`，格式见 `docs/di-home.md` §6）。

## 4. 工业级路线图

按"先能用、再可信、后规模化、终可观测"排序。每阶段标注**依托的现有接缝**（多数已留好）与
**验收信号**。成本费率占位值（`DeepSeekAdapter.Catalog`）建议在任何发布前先核对官方定价。

### Phase A —— 可发布（Distribution & UX）

把"能跑"变成"能分发、能脚本化、中断友好"。

- **全局命令**：自包含 / 单文件发布 + `di` 入 PATH；`di --version`、`di --help`、`di --model <名>`。
- **headless 模式**：`di "prompt"`、`di -p <file>`、stdin 管道；`--yes` 无交互自动放行。
- **回合级 Ctrl+C**：✅ 已实现（§3 缺口 #3）——**递进式**：第一次软停止（相位边界收敛，保留会话）、
  第二次硬取消在途工作、无回合时退出进程。语义与状态机见 `docs/interrupt.md`。
- **交互体验**：readline 历史（↑↓）、行编辑、斜杠命令 / 模型名 / skill 名补全。
- **TS TUI（M1 ✅；M4 默认交互前端 ✅）**：`tui/` 复用 `@earendil-works/pi-tui`，驱动 `di --mode rpc`，
  端到端（流式文本 / 工具 / 输入 / 中断）已跑通（M1）；本变更完成 M4 安装整合 —— `install.*`
  构建并安装 TUI 到 `~/.di/tui/`（node/npm 缺失只告警不失败），`di` 交互默认启动 TUI
  （`node <entry>` 继承控制台），`DI_UI=repl` 逃生门回退旧 REPL（入口缺失 / 无 node / spawn 失败
  同样回退）；全屏化（M2）与增强（M3）仍待办，见 `docs/tui.md`。
- 验收：`di "读一下 README"` 在 CI 管道里能跑通并返回 0；中途 Ctrl+C 后会话文件仍完整。

### Phase B —— 安全与可信（工业级第一优先）

让 harness **值得被信任去动用户的东西**。

- **权限层落 `IToolValidator`**（缝已留，MVP 传 null）：默认策略"询问 / 允许 / 拒绝"；
  危险命令检测（rm -rf、format、git push --force 等）；编辑类工具 **diff 预览审批**；
  allowlist / denylist 持久化到 `~/.di/policies.json`。
- **撤销与检查点**：每次写操作前自动 git 检查点（commit / stash），支持 undo；删除进回收站。
- **提示注入防御**：工具输出 / 文件内容与用户指令区分（标记"内容是数据不是指令"）；
  不可信上下文（网页、文件）隔离，禁止其注入工具参数。
- **敏感信息卫生**：API key 绝不落日志 / 会话文件；`--debug` 结构化日志默认脱敏。
- 验收：破坏性操作必有确认或白名单；恶意文件内容无法诱导模型执行命令（注入测试用例全绿）。

### Phase C —— 上下文与记忆工程

把"够用"变成"长会话不崩、跨会话有记忆"。

- **token 预算管理**：✅ 基础版已实现（§3 缺口 #4）——跨回合记忆按窗口比例丢最旧整回合；
  超限自动**压缩**（总结旧回合）与会话内输出缓冲计数仍属后续。
- **`/resume` 会话恢复**：`SessionLog` 已可重放，接回 UI（`--resume [session-id]`）。
- **项目记忆与 AGENTS.md**：`~/.di/memory/<project>.md` 长期事实（跨会话）；项目级
  `AGENTS.md` 作为指令注入（当前是代码内默认 `CoreTools.BuildInstructions` 的输出）。
- **缓存友好深化**：✅ 基础版已实现——`task_complete` 落盘 `usage`（含 cache_read/cache_write 与
  命中率），`di --stats <file>` 做会话级聚合（DeepSeek 已给 cache_read/cache_write token，
  `CostCalculator` 已按缓存价计费）——命中率可观测，优化有依据。
- 验收：连续 50 回合的会话 token 不超窗；`/resume` 后模型记得上一会话关键结论。

### Phase D —— 生态扩展（Ecosystem）

把"单机单 agent"变成"可插拔平台"。

- **MCP 桥**：`~/.di/mcp.json`（stdio 命令 + 环境）→ 桥接为 `ICoreTool`，ReAct 无感。
- **子代理**：`~/.di/agents/*.md` 定义 plan / research / review 角色——独立 loop + 上下文
  + 结果回传（事件总线已支持跨代理观察，`AgentRunner` 可作复用骨架）。
- **命令注册表**：✅ 已实现（MVP）——`Repl.RunCommand` 的 if/else → `SlashCommandRegistry`
  注册表（对齐 Pi 的 `SlashCommands` 服务）+ 内置命令 + `~/.di/commands/*.md` 用户命令
  （`Di.Cli/Commands/`，格式见 `docs/di-home.md` §6），REPL 与 `--mode rpc` 共用；
  命令参数补全（argument hint 已备，接编辑器补全属 M3）。
- **第二 provider**：加一个 OpenAI 兼容或 Anthropic 适配器——验证抽象正确性、获得故障切换
  （provider A 429 时切 provider B）。**这是检验模型层设计是否真的"厂商无关"的最强测试。**
- **模型目录外置数据**：Catalog 从代码常量 → `data/*.json` + 动态刷新 + 在线模型列表。
- 验收：同一个 ReAct 不加改动跑第二个 provider；MCP 服务器一个 JSON 配置接入。

### Phase E —— 可观测与产品化（Observability & Product）

把"能用"变成"可度量、可运营、可迭代"。

- **遥测**：事件总线 → 指标（每回合 token/cost/延迟/工具分布）；跨会话成本 / 用量聚合看板、
  预算告警（成本数据已在 `AgentResult.Cost` + `SessionLog.task_complete.cost`，只差聚合）。
- **评估与回归**：工具用法的自动评测集（多步编码任务）；CI 注入真实 key 跑 2 个
  `SkippableFact` 集成测试；对每次模型层改动跑成本 / 用量断言（防止费率回退）。
- **性能预算**：端到端延迟（首 token 时间、SSE 吞吐）可测；前缀缓存命中率纳入会话统计。
- **运维命令**：`di doctor`（环境自检）、`di config validate`、升级与配置迁移。
- 验收：一次会话结束后能在看板看到总成本与逐工具分布；模型升级能对比命中率与成本。

## 5. 一张图的演进关系

```
MVP（已达成，5 个缺口全补齐）    工业级
───────────────             ──────────────
循环/流式/工具/skills/会话   A 分发与 UX（分发/headless/Ctrl+C ✅，TS TUI M1 ✅ + 默认交互前端 M4 ✅，readline 补全等后续）
成本/目录/认证/元数据        B 安全与可信（权限审批/撤销/注入防御）★
事件总线/分层配置/779 测试    C 上下文与记忆（token 预算基础版 ✅，压缩/resume 后续）
                            D 生态（MCP/子代理/第二 provider/命令注册表）
                            E 可观测与产品化（遥测/评估/运维命令）
```

> **建议**：MVP 已收尾，下一步进 **Phase B**——对一个会动文件的编码 harness，
> **安全与可信是工业级的第一道门槛**，其余各阶段都建立在"用户敢让它自己改代码"之上。
