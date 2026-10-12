# Di Harness 功能全景、MVP 评估与工业级路线图

> 设计文档。回答三个问题：
> 1. 本项目已经实现了哪些 harness 功能（可复核的能力清单）；
> 2. 作为一个 MVP harness 还缺什么；
> 3. 要走向工业级 harness，下一步做什么、按什么顺序、依托哪些已有接缝。
>
> 配套文档：`docs/architecture.md`（架构与关键决策）、`docs/di-home.md`（家目录与配置规范）。

---

## 1. 一句话定位

Di 是一个**无外部框架依赖的 ReAct coding-agent harness**：模型层（流式优先 + 重试 + 成本核算）→
循环层（ReAct + 事件总线）→ 能力层（8 个内置编码工具 + Skills 渐进式披露）→ 宿主层
（REPL + 会话 JSONL + 分层配置）。核心思想：**一切厂商怪癖收敛在适配器翻译层、模型是纯数据、
认证是声明、循环只发事件不渲染**。

代码规模：Core + Common + Di.Cli 共 49 个源文件；Di.Tests + Di.Cli.Tests 共 39 个测试文件，
**584 个用例全绿**（Di.Tests 474 + Di.Cli.Tests 110；另有 2 个 DeepSeek 集成测试默认跳过）。

---

## 2. 已实现功能清单（按子系统，均可复核）

> 每项给出：能力 → 代码落点 → 测试落点。测试数量为该文件 `[Fact]/[Theory]` 计数（属性数，非展开数）。

### 2.1 核心循环 —— Core.AgentLoop（37 测试）

| 能力 | 落点 | 说明 |
|---|---|---|
| ReAct 主循环（流式/非流式双路径） | `ReAct.cs` | 非流式聚合为一次调用；流式把文本增量逐字发事件，UI 实时渲染 |
| 四种停止条件 | `AgentResult.cs` | `Answer` / `FinalOutputTool` / `MaxIterations` / `Error` |
| 迭代预算 | `AgentLoopOptions.MaxIterations` | 防无限循环；预算耗尽不再执行工具（结果无消费者） |
| 工具失败 = 观察，不是崩溃 | `ReAct.ExecuteToolAsync` | 异常 → `error: ...` 观察文本回填模型，可继续纠正 |
| 不可重试模型错误 → 干净结局 | `ReAct.RunCoreAsync` | `LlmException`（非可重试）→ `AgentStopReason.Error` + `LlmFailure` |
| 跨回合记忆 + 整回合裁剪 | `AgentRunner` | 每回合轨迹累加，按最近 10 个整回合（user 消息处切）裁剪 |
| 环境快照 append-on-change | `EnvironmentSnapshot.cs` | git 分支/最近提交/未提交变更注入历史；只在内容变化时追加，稳定期零重复支付；git 缺失静默省略 |
| 最终输出工具 | `AgentLoopOptions.FinalOutputTool` | 模型调用它即声明完成，参数即答案 |
| 工具校验缝 | `IToolValidator` | 执行前校验挂点；MVP 传 null 跳过 |
| 成本跨轮累计 | `ReAct.CombineCost` | `ModelResponse.Cost` 累加 → `AgentResult.Cost` / `TurnCompleted.Cost` |

### 2.2 模型层 —— Core.Llm（45 测试）

| 能力 | 落点 | 说明 |
|---|---|---|
| Provider 路由（动态注册/替换） | `LlmRuntime` / `ChatAdapter.ProviderIds` | `RegisterAdapter` 返回句柄，原子替换/撤销 |
| 流式一等公民 + 协议义务 | `StreamChunk.cs` | Usage 必须在 Finish 前；Finish 后不得再有任何块；工具参数全程原始 JSON |
| 流式装配 | `ChatAssembler` | text/reasoning/tool-call 按块 index 合并 |
| 重试装饰器 | `RetryingChatModel` | 可重试故障（429/超时/连接/5xx）指数退避 + `Retry-After` + ±20% 抖动；流式整体重枚举，对 ReAct 透明 |
| token 计量 | `TokenUsage` | 缓存命中/写入/推理 token 独立计数；`Add` 用 `SumOrNull` 保留可空字段 |
| 成本核算 | `CostAccounting.cs` | `UsageCost`（input/output/cache_read/write + Total）+ `CostCalculator` 按每百万 token 费率折算 |
| 模型目录（模型即纯数据） | `ModelCatalog.cs` / `ChatAdapter.Catalog` | `ListModels` / `ResolveModelAsync` / `CalculateCost` 全从目录派生；加模型 = 目录加一条，引擎零改动 |
| 认证抽象（声明即数据） | `LlmAuth.cs` / `ILlmCredentialStore.cs` | 适配器声明 `Auth`（如 `EnvApiKey`），凭据在**请求时**解析（config > env），缺 key 不崩启动 |
| 响应元数据 | `IChatModel.ModelResponse` | `Cost` / `ResponseId` / `Timestamp` / `DurationMs`；`StreamChunk.ResponseInfo` 由适配器上报 |
| 采样参数透传 | `ModelRequest` / `GenerateOptions` | top_p / frequency_penalty / presence_penalty，未设置保持 null 交适配器缺省 |
| 结构化错误 | `LlmException` | 稳定错误码 + `IsRetryable` + status + `Retry-After`；无裸异常 |
| Finish 后拒绝坏 chunk | `ChatModelClient.StreamAsync` | 协议义务防御：坏适配器 Finish 后再发内容被截断 |
| 消息词汇 | `ChatMessage` / `ContentBlock` | reasoning 一等公民；`OpaqueBlock` 无损透传未知块 |

### 2.3 DeepSeek 适配器 —— Core.Providers.DeepSeek（16 测试）

| 能力 | 落点 | 说明 |
|---|---|---|
| HTTP/SSE 传输 + 分帧 | `DeepSeekAdapter` | 手写最小 SSE 解析；坏 chunk 跳过不崩流 |
| 错误翻译 | `DeepSeekAdapter.SendAsync` | 非 2xx → 结构化 `LlmException`（429→RateLimited、401/403→MissingCredential） |
| 线格式翻译（唯一居所） | `DeepSeekTranslator` | 5 条 DeepSeek 怪癖：历史 reasoning 回传、tool_choice 限制、effort 规则、可空集合、strict 域名 |
| 前缀缓存优化 | `DeepSeekTranslator` + `AgentRunner` | 稳定前缀（prompt+历史）在前、易变 SystemContext 在后；未设置集合绝不序列化成 `[]`；快照 append-on-change |
| 模型目录（2 模型 + 费率） | `DeepSeekAdapter.Catalog` | `deepseek-flash` / `deepseek-v4-pro`，含 context window / 推理档位 / 成本费率（⚠ 费率是占位值，需按官方定价核对） |
| 请求时鉴权 | `DeepSeekAdapter.ResolveApiKeyAsync` | config `DeepSeek:ApiKey` 优先，环境变量 `DEEPSEEK_API_KEY` 兜底 |
| 响应标识上报 | `DeepSeekAdapter.StreamAsync` | 首个带 id 的 chunk 发 `ResponseInfo` |

### 2.4 工具 —— Core.Tools（239 测试）

| 能力 | 落点 | 说明 |
|---|---|---|
| 8 个内置编码工具 | `CoreTools.cs` | read_file / write_file / edit_file / glob / grep / bash / powershell / python |
| 注册表与工具集 | `CoreTools.CreateTools` | 单工具路由（未知名抛错）+ all/coding/read-only 三种组合 |
| 共享持久化 shell 会话 | `ShellSession` / `BashTool` / `PowerShellTool` | cwd/环境变量跨调用保持；bash 与 powershell 各自独立会话（语法/编码不同） |
| 有界输出 | `OutputBuffer` | 任意长度输出内存恒定（头尾预算），超长截断头尾 |
| 超时强杀 + 会话自动重建 | `ProcessRunner` / `ShellSession` | 默认 30 秒，超时返回 error，会话重建 |
| Windows 编码处理 | `ProcessEncoding` | cmd/python 的 OEM 字节 vs git 的 UTF-8 字节分别解码 |
| 精准编辑 | `EditFileTool` | old_string 唯一性校验，避免错误覆盖 |
| schema 与实现同源 | `CoreTools.Definitions` / `CreateExecutor` | 共用同一注册表，定义与执行器永不失配 |
| 工具使用说明由工具自身贡献聚合、注入稳定前缀 | `CoreTools.BuildInstructions` | 每工具 `PromptSnippet`/`PromptGuidelines` co-locate（对齐 pi），与 schema 同源；模型知道工具约定（error 前缀、长输出截断等） |

### 2.5 Skills —— Core.Skills（44 测试）

| 能力 | 落点 | 说明 |
|---|---|---|
| SKILL.md 解析（严格校验） | `SkillMarkdown` | 字段唯一、name 匹配目录、非法即拒绝、未知字段忽略 |
| 两级发现合并 | `SkillRepository` | `~/.di/skills` + `<workspace>/.di/skills`，项目覆盖用户；无效跳过只告警 |
| 词法自动匹配 | `LexicalSkillMatcher` | ASCII 单词 + 中文二元组，查询覆盖率；embedding 为升级路径（换实现即可） |
| 渐进式披露 | `SkillContext` + `SkillTools` | 未激活只广告 name+description（~100 token）；`load_skill` 工具按需加载完整指令 |
| 固定激活 /skill | `Repl.ActivateSkill` | 手动固定跨回合保持；自动匹配每回合重算，二者可叠加 |
| 匹配质量评估 | `SkillEvaluator` | 精确率/召回率/无匹配率/上下文成本，在带标签用例集上统计 |

### 2.6 会话与配置 —— Core.Sessions + Core.Configuration（15 测试）

| 能力 | 落点 | 说明 |
|---|---|---|
| 会话 JSONL（对齐 codex 格式） | `SessionLog` | `{timestamp, ordinal, type, payload}` 信封；首行 session_meta；每回合 task_started / turn_context / response_item / task_complete |
| 会话成本落盘 | `SessionLog.AppendTurn` | task_complete 带 `cost`（无费率时省略） |
| 追加按行 flush | `SessionLog` | 进程中断不损坏已写记录；线程安全（单锁 + 单调 ordinal） |
| 尽力而为 | `SessionLog` 调用方 | 磁盘错误只告警，绝不打断聊天 |
| 家目录单一来源 | `DiHome` | `~/.di`（`DI_HOME` 可覆盖）；派生 config/sessions/skills/commands/agents/mcp |
| 分层配置（4 源） | `DiConfig` | appsettings → `~/.di/config.json` → `<workspace>/.di/config.json` → 环境变量，后覆盖前 |
| 所有权规则 | `DiHome` / `SessionLog` | 程序只写 sessions/，配置文件一律只读、不创建、不覆盖 |
| 目录即契约 | `di-home.md` §2 | commands/agents/mcp 目录与格式已预留，实现渐进 |

### 2.7 事件总线 —— Common.Events（21 测试）

| 能力 | 落点 | 说明 |
|---|---|---|
| push 订阅 + pull 消费 | `InMemoryEventBus` | `Subscribe(IEventHandler)` + `CreateConsumer()`，多态派发 |
| 异常隔离 | `EventBusOptions.OnHandlerError` | 单个坏订阅者不拖垮循环，只告警 |
| 循环/UI 解耦 | `Repl.RunTurnAsync` | ReAct 只发事件，UI 从总线消费渲染；日志/遥测走同一总线 |

### 2.8 CLI / UI —— Di.Cli（110 测试）

| 能力 | 落点 | 说明 |
|---|---|---|
| REPL 外层循环 | `Repl` | 读行 → 斜杠命令 → 回合；回合事件实时渲染 + 兜底排空 |
| 流式渲染 | `EventRenderer` | 逐字输出；工具调用/思考轮/用量+成本脚注；ANSI 状态行（重定向自动禁用） |
| 斜杠命令 | `Repl.RunCommand` | `/help` `/clear` `/model` `/skills` `/skill` `/exit` |
| 纯参数解析（语言无关契约） | `cli/CliArgs.cs` | `string[] → CliArgs` 纯数据 + 诊断；`--` 截断、未知/缺值/非法模式报错 |
| 纯模式解析 | `cli/CliMode.cs` | `Resolve(args, stdinTty, stdoutTty)`；短路径优先（version/help/list-models 不建 DI） |
| 分派壳 | `CliApp` | 解析 → 校验 → 模式 → 建宿主 → 分派；不碰 Console（流与 TTY 由调用方注入） |
| 组合根 | `CliHost.Create` | 配置 → AddDi() → 工具/skills/runner/会话；`--provider/--model/--thinking` 覆盖在此生效 |
| headless 单发 | `modes/PrintMode` | 文本流式渲染 / JSON 单文档；stdin 读提示词；错误 exit 1；会话日志（`--no-session` 关闭） |
| 全局命令分发 | `Properties/PublishProfiles/di.pubxml` + `install.cmd/ps1` | win-x64 自包含单文件 di.exe → `~/.di/bin` → PATH 幂等 |
| 模型切换 | `AgentRunner.CurrentModel` | 运行中切换，按名经工厂解析 |
| 模型工厂 | `DiServiceCollectionExtensions` | `RetryingChatModel(ChatModelClient(llm, provider, name))` 组合 |
| UTF-8 输出 | `Program.cs` | 显式 `Console.OutputEncoding=UTF8`：GBK 代码页下中文不乱码（管道/脚本安全） |

### 2.9 测试与质量

- **584 个用例全绿**，横跨 loop / 模型层 / provider / 工具 / skills / 会话 / 配置 / 事件 / CLI 九大域。
- 工具域最厚（239），覆盖编码、超时、有界输出、会话保持、Windows 编码。
- 2 个 DeepSeek 真实集成测试（`SkippableFact`）默认跳过，留作 CI 注入真实 key 时跑。
- 全程 TDD：每个单元先写测试看红，再实现转绿（CLAUDE.md 强制）。

---

## 3. MVP 评估

### 3.1 结论

**核心 harness 已达成并超出 MVP**：循环、流式、8 工具、skills、会话、成本、配置、事件总线、
测试——一个编码 agent 该有的骨架全部在，且工程质量高（协议义务化、错误结构化、模型纯数据、
成本可核算）。

但作为**能被真实使用的产品**，还有 5 个"可用性"缺口。它们不涉及架构，是入口、健壮性与
文档层面的补全。**#1（全局命令）、#2（headless 单发）、#5（README）已实现**（见 `docs/cli.md`），
剩余 2 个：

| # | 缺口 | 现状 | 为什么算 MVP 缺口 | 建议落点 |
|---|---|---|---|---|
| 1 | **全局命令与分发** | ✅ 已实现：`di.exe`（win-x64 自包含单文件）+ `install.cmd`/`install.ps1` 入 PATH，幂等 | 一个不能被"安装并运行"的 harness 不是 MVP | `Di.Cli/Properties/PublishProfiles/di.pubxml` + 仓库根安装脚本 |
| 2 | **非交互单发模式** | ✅ 已实现：`di "prompt"`、`di --mode json`、stdin 管道、`-m/--provider/--no-session/--no-ansi` | 脚本化、CI、自动化测试都需要 headless；Claude Code/Codex 均有 | `CliApp` 分派 + `modes/PrintMode`；契约见 `docs/cli.md` |
| 3 | **回合级中断（Ctrl+C）** | 无 `Console.CancelKeyPress` 注册；取消 = 整个进程退出，会话无收尾 | 长回合（跑测试/大文件）中断应只取消当前回合，保留已写入会话 | `CancellationTokenSource` 挂到 `CancelKeyPress` |
| 4 | **上下文 token 预算** | 仅按"最近 10 个整回合"裁剪；工具输出可让单回合暴涨 | 读大文件/跑测试可瞬间超窗，10 轮启发式防不住；架构 §5 已自记此缺口 | 按模型 context window 比例预算，超限压缩/裁剪/报错 |
| 5 | **README 与上手文档** | ✅ 已实现：README 安装/用法/配置 + `docs/cli.md` 契约 | 一个要被用的项目必须有"装什么/怎么跑/怎么配" | 仓库根 `README.md` + `docs/cli.md` |

> 其余未实现项（`/resume`、命令注册表、MCP、子代理、权限审批流、遥测、多 provider、登录命令）
> 都不属于 MVP 必须 —— 它们是工业级范畴，见 §4。

---

## 4. 工业级路线图

按"先能用、再可信、后规模化、终可观测"排序。每阶段标注**依托的现有接缝**（多数已留好）与
**验收信号**。成本费率占位值（`DeepSeekAdapter.Catalog`）建议在任何发布前先核对官方定价。

### Phase A —— 可发布（Distribution & UX）

把"能跑"变成"能分发、能脚本化、中断友好"。

- **全局命令**：自包含/单文件发布 + `di` 入 PATH；`di --version`、`di --help`、`di --model <名>`。
- **headless 模式**：`di "prompt"`、`di -p <file>`、stdin 管道；`--yes` 无交互自动放行。
- **回合级 Ctrl+C**：取消当前回合（保留已写入会话）、第二次 Ctrl+C 才退出。
- **交互体验**：readline 历史（↑↓）、行编辑、斜杠命令/模型名/skill 名补全。
- 验收：`di "读一下 README"` 在 CI 管道里能跑通并返回 0；中途 Ctrl+C 后会话文件仍完整。

### Phase B —— 安全与可信（工业级第一优先）

让 harness **值得被信任去动用户的东西**。

- **权限层落 `IToolValidator`**（缝已留，MVP 传 null）：默认策略"询问/允许/拒绝"；
  危险命令检测（rm -rf、format、git push --force 等）；编辑类工具 **diff 预览审批**；
  allowlist/denylist 持久化到 `~/.di/policies.json`。
- **撤销与检查点**：每次写操作前自动 git 检查点（commit/stash），支持 undo；删除进回收站。
- **提示注入防御**：工具输出/文件内容与用户指令区分（标记"内容是数据不是指令"）；
  不可信上下文（网页、文件）隔离，禁止其注入工具参数。
- **敏感信息卫生**：API key 绝不落日志/会话文件；`--debug` 结构化日志默认脱敏。
- 验收：破坏性操作必有确认或白名单；恶意文件内容无法诱导模型执行命令（注入测试用例全绿）。

### Phase C —— 上下文与记忆工程

把"够用"变成"长会话不崩、跨会话有记忆"。

- **token 预算管理**：按模型 context window 比例设预算，超限自动**压缩**（总结旧回合 /
  裁剪工具输出 / 丢最旧回合），替代固定 10 轮启发式；会话内输出缓冲计数。
- **`/resume` 会话恢复**：`SessionLog` 已可重放，接回 UI（`--resume [session-id]`）。
- **项目记忆与 AGENTS.md**：`~/.di/memory/<project>.md` 长期事实（跨会话）；项目级
  `AGENTS.md` 作为指令注入（当前是代码内默认 `CoreTools.BuildInstructions` 的输出）。
- **缓存友好深化**：前缀缓存命中率指标（DeepSeek 已给 cache_read/cache_write token，
  `CostCalculator` 已按缓存价计费）——命中率可观测，优化有依据。
- 验收：连续 50 回合的会话 token 不超窗；`/resume` 后模型记得上一会话关键结论。

### Phase D —— 生态扩展（Ecosystem）

把"单机单 agent"变成"可插拔平台"。

- **MCP 桥**：`~/.di/mcp.json`（stdio 命令+环境）→ 桥接为 `ICoreTool`，ReAct 无感。
- **子代理**：`~/.di/agents/*.md` 定义 plan / research / review 角色——独立 loop + 上下文
  + 结果回传（事件总线已支持跨代理观察，`AgentRunner` 可作复用骨架）。
- **命令注册表**：`Repl.RunCommand` 的 if/else → 从 `~/.di/commands/*.md` 加载。
- **第二 provider**：加一个 OpenAI 兼容或 Anthropic 适配器——验证抽象正确性、获得故障切换
  （provider A 429 时切 provider B）。**这是检验模型层设计是否真的"厂商无关"的最强测试。**
- **模型目录外置数据**：Catalog 从代码常量 → `data/*.json` + 动态刷新 + 在线模型列表。
- 验收：同一个 ReAct 不加改动跑第二个 provider；MCP 服务器一个 JSON 配置接入。

### Phase E —— 可观测与产品化（Observability & Product）

把"能用"变成"可度量、可运营、可迭代"。

- **遥测**：事件总线 → 指标（每回合 token/cost/延迟/工具分布）；跨会话成本/用量聚合看板、
  预算告警（成本数据已在 `AgentResult.Cost` + `SessionLog.task_complete.cost`，只差聚合）。
- **评估与回归**：工具用法的自动评测集（多步编码任务）；CI 注入真实 key 跑 2 个
  `SkippableFact` 集成测试；对每次模型层改动跑成本/用量断言（防止费率回退）。
- **性能预算**：端到端延迟（首 token 时间、SSE 吞吐）可测；前缀缓存命中率纳入会话统计。
- **运维命令**：`di doctor`（环境自检）、`di config validate`、升级与配置迁移。
- 验收：一次会话结束后能在看板看到总成本与逐工具分布；模型升级能对比命中率与成本。

---

## 5. 一张图的演进关系

```
MVP（现状，已达成）           工业级
───────────────             ──────────────
循环/流式/工具/skills/会话   A 分发与 UX（能分发/脚本化/中断友好）
成本/目录/认证/元数据        B 安全与可信（权限审批/撤销/注入防御）★
事件总线/分层配置/584 测试    C 上下文与记忆（token 预算/resume/项目记忆）
                            D 生态（MCP/子代理/第二 provider/命令注册表）
                            E 可观测与产品化（遥测/评估/运维命令）
```

> **建议**：先完成 §3 的 5 个 MVP 缺口（约 1 周量级），再进 Phase B——对一个会动文件的
> 编码 harness，**安全与可信是工业级的第一道门槛**，其余各阶段都建立在"用户敢让它自己改代码"
> 之上。
