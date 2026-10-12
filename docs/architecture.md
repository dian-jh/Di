# Di 架构与功能总览

> 本文件是 Di（agent harness）的**架构快照**：分层结构、模块职责、一次回合的数据流、
> 已实现功能清单与关键设计决策。随代码演进维护；改架构时同步更新这里。
> 配置规范另见 [di-home.md](./di-home.md)；harness 能力清单、MVP 差距与工业级路线图另见
> [harness.md](./harness.md)。

---

## 1. 一句话定位

Di 是一个 **C# / .NET 10 的本地编程 agent harness**：终端 REPL 接收用户输入，
驱动 **ReAct 循环** 调用大模型（当前为 DeepSeek），模型通过 **八个内置编码工具**
（读/写/编辑文件、glob、grep、bash、powershell、python）在工作区内完成任务，
整个过程经 **事件总线** 流式渲染，回合落盘为 **JSONL 会话日志**，
并支持 **skills**（按需加载的指令工作流）。

```
用户输入
   │  Repl
   ▼
AgentRunner ──► ReAct 循环 ◄── IChatModel（ChatModelClient → RetryingChatModel → LlmRuntime）
   │              │  ▲                │
   │              │  └── 工具调用 ── CoreTools.Executor（8 个内置工具）
   │              ▼
   │        AgentLoopEvent（事件总线）
   ▼
EventRenderer（流式渲染） / SessionLog（JSONL 落盘）
```

---

## 2. 项目结构与分层

```
E:\Agent\Di\
├── Common/            # 与具体业务无关的基础设施
│   └── Events/        # 进程内事件总线（push 订阅 + pull 消费，多态派发）
├── Core/              # harness 核心（无 UI，可被任意宿主复用）
│   ├── AgentLoop/     # ReAct 循环、AgentRequest/Result、环境快照、工具执行抽象
│   ├── Llm/           # 模型层：路由、适配器抽象、消息词汇、流式装配、重试、用量计量
│   ├── Providers/
│   │   └── DeepSeek/  # DeepSeek 适配器（线格式翻译 + HTTP/SSE + 缓存优化）
│   ├── Tools/         # 八个内置编码工具 + 注册表/进程/会话执行器
│   ├── Skills/        # SKILL.md 解析、发现合并、词法自动匹配、load_skill 工具、评估
│   ├── Sessions/      # 会话 JSONL 落盘（SessionLog）
│   └── Configuration/ # 家目录（~/.di）单一来源
├── Di.Cli/            # 终端宿主：组合根、REPL、AgentRunner、事件渲染
├── Di.Tests/          # Core 层单元/集成测试
└── Di.Cli.Tests/      # CLI 宿主测试
```

依赖方向：`Di.Cli → Core → Common`，适配器只依赖 Core 抽象，宿主不认识任何具体厂商。

---

## 3. 各模块职责

### 3.1 Common.Events —— 事件总线

- `IEventBus`（`InMemoryEventBus` 实现）：进程内总线，线程安全。
- **两种消费模式**（互不干扰）：
  - **push 订阅**（`Subscribe`）：fan-out，适合日志/遥测/安全等旁路观察；`Dispose` 令牌退订。
  - **pull 消费**（`CreateConsumer`）：`Channel<T>` 有序流，适合 CLI UI 渲染（按序 + 背压）。
- **多态派发**：事件沿继承链向上投递——订阅/消费基类 `AgentLoopEvent` 收到全部具体事件。
- **异常隔离**：单个订阅者抛异常不中断其它订阅者；可配置错误接收器。
- 事件基类 `Event`：Id / CreatedAt / CorrelationId（把一次运行的事件串起来）。

### 3.2 Core.AgentLoop —— ReAct 循环

- **`ReAct`**：无外部依赖的主循环。
  - 轨迹 = 历史 + 用户消息；循环内：模型决策 → 追加 → 有工具调用则执行并回填观察 → 再决策。
  - 停止条件：无工具调用的回答 / 最终输出工具 / 达到 `MaxIterations` / 不可重试模型错误。
  - **工具失败 = 观察结果**（模型可据此纠正），不是崩溃。
  - **消息布局（缓存关键）**：`[稳定 system prompt] + [完整轨迹] + [易变 SystemContext 于请求末尾]`。
    - 稳定前缀（system prompt + 历史）逐字节不变、跨回合单调增长 → 命中 DeepSeek 前缀缓存。
    - 易变上下文（skill 指令）只在末尾，不进入持久历史。
  - 发布 `AgentLoopEvent`（TextDelta/TurnCompleted/ToolStarted/ToolCompleted/RunFailed）。
- **`AgentRequest` / `AgentResult`**：一次运行的输入/结局（轨迹可重放、用量、停止原因）。
- **`EnvironmentSnapshot`**：工作区状态渲染（工作目录、git 分支、最近提交、未提交变更），
  尽力而为（git 缺失/超时静默省略）、紧凑截断、按 UTF-8 解码 git 输出。
- **`IToolExecutor` / `IToolValidator`**：执行与安全/权限挂点，loop 不认识具体工具。

### 3.3 Core.Llm —— 模型层

- **`ILlmService` / `LlmRuntime`**：适配器注册/路由/请求分发。
  - 适配器按 `ProviderIds` 装入路由表；`RegisterAdapter` 返回句柄，可原子替换/撤销路由。
  - `StreamAsync` 前置校验：模型是否支持所请求的推理强度（不支持抛 UNSUPPORTED_OPTION）。
  - `ListModels`（同步尽力而为，从不抛）、`CalculateCost`（查模型目录费率）、`CheckAuthAsync`。
  - **请求时鉴权**：适配器声明 `Auth` 后，`StreamAsync` 先解析凭据（config > 环境变量），
    缺 key 抛 `MISSING_CREDENTIAL`——DI 注册不再要求 key，CLI 无 key 也能启动。
- **`ChatAdapter`**（抽象，唯一抽象成员 `StreamAsync`）：提供方线格式适配器。
  - `StreamChunk` 协议义务：Usage 必须在 Finish 之前；工具参数全程原始 JSON 字符串；
    错误只有"抛出 LlmException（传输/协议）"或"Finish(Error/Aborted)（带内）"两条合法路径。
  - **`Auth`**（`LlmAuthDefinition`）：鉴权声明即数据（如 `EnvApiKey(显示名, 环境变量列表)`）；
    `ResolveApiKeyAsync(provider, store)` 默认走凭据存储，适配器可覆盖（config 优先）。
  - **`Catalog`**（`IReadOnlyList<ModelSpec>`）：模型即纯数据；`ListModels` / `ResolveModelAsync` /
    `CalculateCost` 全部从目录派生，未知模型落缺省不抛。加模型 = 目录加一条，引擎零改动。
- **`LlmAuthDefinition` / `ILlmCredentialStore`**：认证与凭据存储分离——
  声明（用什么变量/显示名）是适配器的数据，解析（环境变量取值）是宿主可注入的存储
  （默认 `EnvironmentCredentialStore`：首个非空环境变量生效）。
- **`CostAccounting`**：`UsageCost`（input/output/cache_read/cache_write + Total，Zero/Add）+
  `CostCalculator.Calculate(rates, usage)` 按每百万 token 费率折算；目录无费率时成本为 null。
- **`ChatModelClient`**：`IChatModel` 标准实现，把 `ModelRequest` → `GenerateOptions` → 消费流；
  `ModelResponse` 携带元数据：**cost**（按目录费率折算）、**responseId**（`StreamChunk.ResponseInfo`）、
  **timestamp**（请求开始 Unix 毫秒）、**durationMs**（单调时钟）；Finish 后拒绝后续 chunk（防坏适配器）。
- **`RetryingChatModel`**（装饰器）：对可重试故障（429/超时/连接/5xx）指数退避重试，
  尊重 `Retry-After` + ±20% 抖动；对 ReAct 完全透明（流式整体重枚举）。
- **`ChatAssembler`**：把流式 chunk 按块 index 装配成 `AssistantMessage`（text/reasoning/tool-call）。
- **消息词汇**（`ChatMessage` / `ContentBlock`）：system/user/assistant/tool 消息；
  text/reasoning/image/file/tool-call/tool-result 块；`OpaqueBlock` 对未知块无损透传。
  **reasoning 是一等公民**——带 tools 时必须完整回放，否则 DeepSeek 400。
- **`TokenUsage`**：互斥计数（input = 未命中，缓存命中单独报 CacheRead/CacheWrite）；
  `Add` 用 `SumOrNull` 保留可空字段，`Zero.Add(x)` 是恒等（避免折叠缓存/推理字段）。
- **采样参数**（`ModelRequest` / `GenerateOptions`）：temperature / top_p / frequency_penalty /
  presence_penalty，未设置保持 null 交给适配器缺省。

### 3.4 Core.Providers.DeepSeek —— DeepSeek 适配器

- **`DeepSeekAdapter`**：HTTP/SSE 传输 + 流式 chunk 归一化；鉴权/baseUrl 请求级，不污染 HttpClient。
  - `TranslateChunk`：usage / reasoning / text / tool-call / finish 的归一化；首个带 id 的 chunk
    发 `ResponseInfo`（响应标识，用于追溯/日志）。
  - 错误翻译：非 2xx → 结构化 `LlmException`（429→RateLimited、401/403→MissingCredential）。
  - **鉴权**：`Auth` = `DEEPSEEK_API_KEY` 环境变量；`ResolveApiKeyAsync` 覆盖为 config
    （`DeepSeek:ApiKey`）优先、环境变量兜底，均在请求时解析。
  - **目录（2 个模型，纯数据）**：`deepseek-flash`（0.28/0.42/0.07 每百万）与
    `deepseek-v4-pro`（1.20/4.00/0.30）——费率是占位值，需按官方最新定价核对（数据，非代码）。
- **`DeepSeekTranslator`**：Core 词汇 ↔ DeepSeek 线格式（所有 DeepSeek 怪癖的唯一居所）：
  1. 带 tools 时历史 reasoning_content 必须完整回传，否则 400。
  2. 思考模式下 tool_choice=required/指定函数会 400。
  3. 思考模式下 reasoning_effort 不应与 type=disabled 同现。
  4. 未设置的集合不能序列化成 `[]`（破坏服务端前缀缓存）。
  5. strict 模式需要 beta 域名；不支持的推理强度抛 UNSUPPORTED_OPTION，不静默降级。
- **缓存优化（已实现）**：
  - 未设置的集合可空序列化，避免 `"stop":[]` 之类让缓存 key 变化 → 全部 miss。
  - usage 顶层字段 `prompt_cache_hit/miss_tokens` 建模正确（`cached_tokens` 嵌套兜底）。
  - `TokenUsage.Add` 的 `SumOrNull` 保留缓存/推理字段（修复 UI 恒显 0 的根因）。
  - **请求布局**：稳定 system prompt + 完整轨迹在前（字节稳定前缀），易变 SystemContext 在末尾。
  - **环境快照 append-on-change 进历史**：只在内容变化时追加，稳定时留在缓存前缀零重复支付；
    被历史裁剪裁掉后自动重置重新注入（长期会话不丢环境上下文）。

### 3.5 Core.Tools —— 八个内置编码工具

**统一形态**（`Core/Tools/ICoreTool.cs`）：每个工具 = 一个 `ChatTool` 定义（给模型的 JSON Schema：
name / description / parameters）+ 一个执行实现 `ExecuteAsync`。参数是模型生成的原始 JSON 字符串；
相对路径都以工作区为根；参数缺失/文件不存在等可预期失败返回 `error:` 开头的**观察文本**（作为普通
工具结果进入上下文，由模型下一轮自行纠正，不是崩溃——见 §6.7）。

**工具清单**（每个工具一个文件，均在 `Core/Tools/`）：

| 工具 | 代码（相对仓库根） | 说明 |
|---|---|---|
| read_file | `Core/Tools/ReadFileTool.cs` | 行号前缀读取；start/end_line 行范围、1MiB 上限；超 2000 行/64KB 截断并给出"用 start_line=N 续读"协议 |
| write_file | `Core/Tools/WriteFileTool.cs` | 整体覆盖写入（非追加），自动建父目录 |
| edit_file | `Core/Tools/EditFileTool.cs` | old_string 唯一性校验的精准替换（比整体重写更安全的推荐方式） |
| glob | `Core/Tools/GlobTool.cs` + `Core/Tools/GlobMatcher.cs` | 文件名模式搜索（`* ? **`），返回相对路径；匹配器独立成文件可单测 |
| grep | `Core/Tools/GrepTool.cs` | 正则内容搜索，`file:行号: 内容` 输出；limit/ignore_case/literal/context |
| bash | `Core/Tools/BashTool.cs` | 一次性独立进程（带 working_dir）或**共享持久化会话**两种模式；超时强杀（默认 30 秒，可 timeout 覆盖）；Windows 手工构造 `cmd /d /s /c` 参数 |
| powershell | `Core/Tools/PowerShellTool.cs` | 独立 PowerShell 持久化会话（语法/编码与 cmd 不同，不能与 bash 共用会话） |
| python | `Core/Tools/PythonTool.cs` | 沙盒临时目录执行代码（计算/数据处理/图表） |

**共享基础设施**（均在 `Core/Tools/`）：

- `ShellSession.cs` —— 持久化 shell 会话：cwd/环境变量/虚拟环境跨调用保持；惰性启动（不执行命令不拉起进程）。
- `ProcessRunner.cs` —— 统一进程执行：超时强杀（含进程树）、输出捕获。
- `ProcessEncoding.cs` —— Windows 输出编码：cmd/python 的 OEM 字节 vs git 的 UTF-8 字节分别解码。
- `OutputBuffer.cs` —— 有界输出累积：头尾预算，任意长度输出内存恒定，长输出截断头尾。
- `ToolHelpers.cs` —— JSON Schema 构造、参数解析（string/int/optional）、路径解析（防越界）。

**注册表与工具集组合**（`Core/Tools/CoreTools.cs`，镜像 pi 的 `core/tools/index.ts` 约定）：

- `ToolNames` —— 8 个工具名常量（`read_file`/`write_file`/`edit_file`/`glob`/`grep`/`bash`/`powershell`/`python`）。
- **三个工具集**：`AllToolNames`（8 个）、`CodingToolNames`（read/write/edit/bash，可写文件编辑集）、
  `ReadOnlyToolNames`（read/glob/grep，只读搜索集）。
  **当前生产代码只用全量**（`Di.Cli/CliHost.cs` 调 `CoreTools.Definitions(workspace)`）；coding/read-only
  是**预留的扩展缝**（注释："可给不同场景暴露不同工具子集"）。pi 自身同样只在 loop 里用全量
  （`createAllToolDefinitions`，pi 的 `packages/coding-agent/src/core/agent-session.ts`），子集经 SDK
  导出供外部消费者——所以留子集不是死代码，是组合能力。未来消费场景：只读/规划模式、
  权限层降级（用户拒绝写操作时切只读集，见 `docs/harness.md` Phase B）、headless/CI 安全模式、
  上下文 token 预算（小工具集 = 更小 schema = 更少 token）。注意 powershell/python 只属于全量集，
  不在 coding/read-only 中（pi 的原始定义，忠实镜像）。
- **组合链路**：`CreateTool`（单工具路由，未知名抛 `InvalidOperationException`）→ `CreateTools`
  （按 `CanonicalOrder` + 工具集过滤组合，顺序与 schema/执行器一致）→ `CreateCodingTools` /
  `CreateReadOnlyTools`（子集便捷工厂）。
- **schema 与实现同源**：`Definitions()`（给模型的 `ChatTool` 列表）与 `CreateExecutor()`（运行时
  `IToolExecutor`）共用同一注册表，定义与执行器**永不失配**；bash/powershell 的定义始终按共享
  持久化会话模式生成（schema 里不含 working_dir，与 `CreateExecutor` 一致）。

**使用说明 `BuildInstructions(workspace)`**（`CoreTools.cs`，输出注入稳定前缀）：

`tools` 参数（走 `ModelRequest.Tools` → 请求体 `tools` 字段）是**机器可读的调用契约**——能调什么、
参数怎么填；工具使用说明补充 schema 表达不了的**操作知识**，两者互补而非冗余。
写法对齐 pi 的 system prompt：**每个工具一行 snippet + 命令式规则 bullet**。说明文本**由工具自身
贡献、动态聚合**，与 schema 同源、不再手写同步（人格"简洁 ReAct 助手、中文回答"由 `Di.Cli/CliHost.cs`
追加，不在此重复）。

- **工具清单**：一行一个工具，snippet 来自各工具的 `PromptSnippet`（`ICoreTool.cs`）——
  只写做什么（`- read_file —— 读取文件内容，带行号...`），参数细节已在 schema 里。
- **规则**：全局 `GlobalPromptGuidelines`（跨工具观察约定/截断/简洁）+ 各工具贡献的
  `PromptGuidelines`，去重聚合（`BuildRules`）。每个工具把行为偏好、协议、观察约定
  co-locate 在自己的定义文件里（如 `ReadFileTool.cs` 的 `PromptGuidelines`），对应 pi 的
  `promptSnippet` / `promptGuidelines`。
- **构建方式**：`BuildInstructions(baseDirectory)` 以共享持久化会话形态创建全量工具集
  （与 `CreateExecutor` 一致），从实例聚合——工具集/顺序/说明三者天然一致。

`BuildInstructions` 的输出作为**第一条 system 消息**落在字节稳定前缀里（见 §3.2），逐字节稳定 →
跨回合/迭代命中 DeepSeek 前缀缓存。可被配置 `AgentLoop:SystemPrompt` 整体覆盖（`Di.Cli/CliHost.cs`）。

**工具流动路径**（声明到执行）：

```
Di.Cli/CliHost.cs
  ├─ CoreTools.Definitions(workspace)         ← 生成 8 个工具 schema
  └─ CoreTools.CreateExecutor(workspace)      ← 生成运行时执行器（含 bash/powershell 持久化会话）
        ↓
Core/AgentLoop/AgentRunner.cs
  ├─ 构造：_tools = [..definitions]（有 skills 时追加 SkillTools.LoadSkillTool，见 §3.6）
  └─ RunAsync：每回合把 _tools 塞进 AgentRequest.Tools
        ↓
Core/AgentLoop/ReAct.cs                        ← 每次迭代都带上完整 tools（内层循环）
        ↓
Core/Llm/ChatModelClient.cs                    ← ModelRequest.Tools → GenerateOptions.Tools
        ↓
Core/Providers/DeepSeek/DeepSeekTranslator.cs  ← ToWireTool 序列化为请求体 tools（name/description/parameters/strict）
```

执行侧：ReAct 只认 `IToolExecutor`（`Core/AgentLoop/IToolExecutor.cs`），由 `AgentRunner` 注入
`CoreTools.Executor`（按工具名分发，未知名返回错误观察）；ReAct 不识别具体工具。

### 3.6 Core.Skills —— Skills（渐进式披露）

- **`SkillMarkdown`**：解析 SKILL.md（YAML frontmatter + 正文），严格校验
  （字段只出现一次、name 匹配父目录名、非法即拒绝、未知字段忽略向前兼容）。
- **`SkillRepository`**：两级发现合并（`~/.di/skills` + `<workspace>/.di/skills`，项目级覆盖），
  无效 skill 跳过并告警，绝不让启动失败。
- **`ISkillMatcher` / `LexicalSkillMatcher`**：按 name+description 语义相关度自动激活；
  离线词法匹配（ASCII 单词 + 中文二元组，查询覆盖率，长描述不被稀释）；
  embedding 语义匹配是升级路径（换实现即可，调用方不感知）。
- **渐进式披露**：未激活 skill 只广告 name+description（~100 token/skill）；
  `load_skill` 工具按需加载完整指令（`SkillAwareExecutor` 拦截执行）。
- **`SkillEvaluator`**：在带标签用例集上评估匹配器（精确率/召回率/无匹配率/上下文成本）。
- **`SkillContext`**：广告块渲染 + 上下文 token 成本估算。

### 3.7 Core.Sessions —— 会话记录

- `SessionLog`：一次 CLI 运行追加写入 JSONL（`~/.di/sessions/YYYY/MM/DD/session-*.jsonl`）。
  - 首行 `session_meta`，之后每回合 task_started / turn_context / response_item / task_complete。
  - 每条记录 `{timestamp, ordinal, type, payload}` 信封，payload snake_case（对齐 codex rollout 格式）。
  - task_complete 顺带记录 `cost`（{input, output, cache_read, cache_write, total}；无费率时省略）。
  - 追加按行 flush（进程中断不损坏已写记录）、线程安全、尽力而为（磁盘错误不打断聊天）。

### 3.8 Core.Configuration —— 家目录与分层配置

- `DiHome`：`~/.di` 单一来源（`DI_HOME` 环境变量可覆盖）；派发 config/sessions/skills/commands/agents/mcp。
- `DiConfig`（Di.Cli）：分层配置——appsettings.json（随 exe）→ `~/.di/config.json` →
  `<workspace>/.di/config.json` → 环境变量，后覆盖前，全部灌进同一个 `IConfiguration`。

### 3.9 Di.Cli —— 终端宿主

- **`Program`**（组合根）：配置分层加载 → `AddDi()` 装配（模型层 + 事件总线 + 重试 + 配置段）
  → 解析 LlmService（API Key 缺失在此抛错）→ 工具/技能/提示词 → AgentRunner → Repl。
- **`Repl`**：外层循环。每回合：建事件消费者 → 自动匹配 skills → 并发渲染任务 →
  运行 AgentRunner → 取消渲染 → 兜底排空事件 → 渲染结果 → 回合落盘。
  斜杠命令：`/help` `/clear`（清屏+清记忆）`/model` `/skills` `/skill` `/exit`。
- **`AgentRunner`**：跨回合宿主。
  - 按当前模型名经工厂解析 `IChatModel`；`ActiveSkills`（固定 + 自动匹配）逐回合注入。
  - **环境快照 append-on-change 进持久历史**（`_lastSnapshotText` 去重，裁剪后重置重注入）。
  - 历史按整回合裁剪到最近 N 轮（默认 10）；`ResetHistory()` 同时重置快照标记。
- **`EventRenderer`**：从总线消费事件流式渲染（TextDelta 逐字、工具调用、思考轮、用量脚注）；
  输出重定向时禁用 ANSI。
- **`IAgentRunner` / `ILineReader`**：宿主抽象（可换实现/换输入源）。

---

## 4. 一次回合的数据流（时序）

```
Repl.RunTurnAsync
  ├─ 创建 AgentLoopEvent 消费者，启动并发渲染任务
  ├─ 词法匹配 skills → AgentRunner.ActiveSkills = 固定 + 自动匹配
  ├─ AgentRunner.RunAsync(用户消息)
  │   ├─ 捕获环境快照；与上次比较，变化才追加为历史 system 消息
  │   ├─ 构建 SystemContext（skill 广告 + 激活 skill 指令）
  │   └─ ReAct.RunStreamingAsync(AgentRequest)
  │       └─ 循环：
  │           ├─ BuildContext = [systemPrompt] + [历史+用户消息] + [SystemContext]
  │           ├─ IChatModel.StreamAsync
  │           │   └─ RetryingChatModel → ChatModelClient → LlmRuntime → DeepSeekAdapter
  │           │       └─ SSE chunk → StreamChunk → ChatAssembler
  │           ├─ 每个流事件 → AgentLoopEvent（总线）→ 渲染任务实时输出
  │           ├─ TurnCompleted（累计 usage）→ 事件总线
  │           ├─ 有工具调用 → IToolExecutor 执行 → 观察回填轨迹 → 下一轮
  │           └─ 无工具调用 → 返回 AgentResult（Answer/轨迹/用量/停止原因）
  ├─ 渲染最终结果（含用量脚注）
  └─ SessionLog.AppendTurn(结果, 开始时间) → JSONL 落盘
```

---

## 5. 已实现功能清单

| 领域 | 功能 | 状态 |
|------|------|------|
| 循环 | ReAct 主循环（流式/非流式） | ✅ |
| 循环 | 多停止条件（Answer / FinalOutputTool / MaxIterations / Error） | ✅ |
| 循环 | 跨回合记忆（历史累加 + 整回合裁剪） | ✅ |
| 循环 | 环境快照进历史（append-on-change，缓存友好） | ✅ |
| 模型 | 模型层路由（provider → 适配器，动态注册/替换） | ✅ |
| 模型 | 流式 chunk 协议（usage/finish 顺序义务、tool args 原始 JSON） | ✅ |
| 模型 | 流式装配（text/reasoning/tool-call 按块 index 合并） | ✅ |
| 模型 | 重试装饰器（指数退避 + Retry-After + 抖动，流式可重枚举） | ✅ |
| 模型 | token 计量（缓存命中/写入/推理 token，可空累加不折叠） | ✅ |
| 模型 | 认证抽象（声明即数据，请求时解析 config>env，缺 key 不崩启动） | ✅ |
| 模型 | 模型目录（模型即纯数据，ListModels/成本费率从目录派生） | ✅ |
| 模型 | 成本核算（按模型费率折算，UI 脚注 + 会话日志 task_complete） | ✅ |
| 模型 | 响应元数据（cost / responseId / 时间戳 / 耗时） | ✅ |
| 模型 | 采样参数透传（top_p / frequency / presence penalty） | ✅ |
| Provider | DeepSeek 适配器（HTTP/SSE/错误翻译/推理强度校验） | ✅ |
| Provider | 前缀缓存优化（请求布局 / 可空集合 / 快照 append-on-change） | ✅ |
| 工具 | read_file / write_file / edit_file | ✅ |
| 工具 | glob / grep | ✅ |
| 工具 | bash（一次性 + 共享持久化会话，Windows cmd 参数处理） | ✅ |
| 工具 | powershell（独立持久化会话） | ✅ |
| 工具 | python（沙盒临时目录） | ✅ |
| 工具 | 注册表与工具集（all/coding/read-only 组合，schema 与执行器同源） | ✅ |
| 工具 | 使用说明由工具自身贡献聚合注入稳定前缀（`CoreTools.BuildInstructions`，可被系统提示词覆盖） | ✅ |
| Skills | SKILL.md 解析（严格 frontmatter 校验） | ✅ |
| Skills | 两级发现合并（用户 + 项目，项目覆盖） | ✅ |
| Skills | 词法自动匹配（中英，查询覆盖率，阈值/上限） | ✅ |
| Skills | 渐进式披露（广告块 + load_skill 按需加载） | ✅ |
| Skills | 匹配器评估（精确/召回/无匹配率/上下文成本） | ✅ |
| 事件 | 进程内总线（push 订阅 + pull 消费、多态派发、异常隔离） | ✅ |
| UI | 流式渲染（逐字输出、工具调用、思考轮、用量脚注） | ✅ |
| UI | 斜杠命令（help/clear/model/skills/skill/exit） | ✅ |
| 持久化 | 会话 JSONL（session_meta + 回合轨迹，对齐 codex 格式） | ✅ |
| 配置 | 分层配置（默认 → 用户 → 项目 → 环境变量） | ✅ |
| 配置 | 家目录 ~/.di 单一来源（DI_HOME 覆盖） | ✅ |
| 分发 | 全局命令 `di` 启动（待做，见下） | ⏳ |

### 待做 / 扩展缝

- **全局命令 `di`**：发布 exe（框架依赖或自包含）→ 放入 PATH（`di.cmd` 桥接或改名为 `di.exe`）。
- **token 上下文预算**：已测量轨迹增长（1829→9863 tokens/会话），未实现自动裁剪策略。
- **`/resume` 会话恢复**：SessionLog 已可回放，未接回 UI。
- **斜杠命令框架**：`~/.di/commands/*.md` 目录已约定，未实现。
- **MCP 桥**：`~/.di/mcp.json` 目录已约定，未实现。
- **embedding 语义匹配**：`ISkillMatcher` 接缝已留，换实现即可。
- **skill 资源/脚本**：allowed-tools 已解析存储，语义（执行前过滤）留给权限层。

---

## 6. 关键设计决策

1. **适配器翻译线格式**：所有厂商怪癖只允许出现在适配器翻译层（DeepSeekTranslator），
   业务与宿主不认识具体厂商 —— 加厂商 = 加一个 DI 扩展 + 一个适配器。
2. **消息词汇是内存内词汇**：`ChatMessage`/`IContentBlock` 是归一化的内存模型；
   线格式 DTO 由适配器各自私有，历史持久化由宿主用类型标签 + 注册表自行实现。
3. **reasoning 一等公民**：思考内容与可见文本分离存储、无损回放（带 tools 时缺它 DeepSeek 400）。
4. **缓存是字节精确前缀匹配**：请求里"稳定内容在前、易变内容在后/不入历史"；
   未设置的集合绝不序列化成空数组 —— 一切为 byte-identical prefix 服务。
5. **事件总线解耦循环与 UI**：ReAct 只发事件不渲染，CLI 从总线消费；日志/遥测走同一总线。
6. **跨回合记忆由宿主管理**：ReAct 只拼装，AgentRunner 负责累加/裁剪/快照去重，
   loop 层保持无状态、可独立复用。
7. **失败是观察不是崩溃**：工具失败 → 错误观察文本回填模型；不可重试模型错误 → 干净结局。
8. **MVP 优先 + TDD**：每个模块最小可用先跑通，测试先行（红→绿），提交用 Conventional Commits。
9. **模型是纯数据、鉴权是声明**：模型目录（Catalog）与认证声明（Auth）都是适配器上的数据，
   凭据存储（ILlmCredentialStore）由宿主注入、请求时才解析——加模型/换凭据来源零引擎改动，
   DI 注册与启动不碰任何密钥。
10. **工具设计（schema 与说明互补、说明与 schema 同源、子集预留）**：`tools` 参数（`ModelRequest.Tools`）
    是机器可读的调用契约（能调什么、参数怎么填），工具使用说明（`CoreTools.BuildInstructions`）是
    注入稳定前缀的操作手册（观察约定、行为偏好、协议）——两者互补而非冗余。说明文本由每个工具
    自己的 `PromptSnippet` / `PromptGuidelines` 贡献聚合（`ICoreTool.cs`），与 schema co-locate、
    永不失配（对齐 pi 的 `promptSnippet` / `promptGuidelines`）。工具集按 all/coding/read-only
    组合预留扩展缝（当前只用全量，镜像 pi 的 `core/tools/index.ts`），未来按场景暴露子集
    （只读模式/权限降级等）；`Definitions` 与 `CreateExecutor` 共用同一注册表，schema 与实现永不失配。
