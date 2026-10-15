# Di 架构总览

> **架构快照**：定位、分层、依赖方向、一次回合的数据流、关键设计决策。
> 随代码演进维护；改架构时同步更新这里。模块级细节见 `modules/README.md`（各模块一篇，模块映射
> 唯一权威），CLI 契约见 `cli.md`，家目录与配置见 `di-home.md`，能力全景与路线图见 `roadmap.md`。

---

## 1. 一句话定位

Di 是一个 **C# / .NET 10 的本地编程 agent harness**：终端 REPL 接收用户输入，
驱动 **ReAct 循环** 调用大模型（当前为 DeepSeek），模型通过 **八个内置编码工具**
（读 / 写 / 编辑文件、glob、grep、shell [Windows 为 cmd、其他平台为 bash]、powershell、python）
在工作区内完成任务，整个过程经 **事件总线** 流式渲染，回合落盘为 **JSONL 会话日志**，
并支持 **skills**（按需加载的指令工作流，渐进式披露）。

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
EventRenderer（流式渲染） / SessionLog（JSONL 落盘） / DiLog（jcode 文本日志，旁路订阅）
```

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
│   ├── Logging/       # 运行日志（DiLog，jcode 格式，~/.di/logs 按日一个文件，事件总线旁路订阅）
│   └── Configuration/ # 家目录（~/.di）单一来源
├── Di.Cli/            # 终端宿主：组合根、REPL、AgentRunner、事件渲染、--mode rpc 后端
├── tui/               # TS 终端前端（Node）：spawn `di --mode rpc`，只依赖 RPC 协议（见 docs/tui.md）
├── Di.Tests/          # Core 层单元/集成测试
└── Di.Cli.Tests/      # CLI 宿主测试
```

依赖方向：`Di.Cli → Core → Common`，适配器只依赖 Core 抽象，宿主不认识任何具体厂商。
`tui/` 是**进程级**前端（TypeScript），不参与 .NET 项目引用图——它作为子进程驱动
`di --mode rpc`，依赖面是 `docs/tui-rpc.md` 的线协议契约（见 `docs/tui.md`），与既有 C# REPL
界面并存。

## 3. 依赖方向（唯一权威）

跨模块**依赖方向**在此唯一维护；模块 ↔ 文档 / 源码目录 / 测试目录的具体映射统一见
`docs/modules/README.md`（唯一权威表），本处不再复制该表。

```
Di.Cli ──► Core ──► Common
```

细化（命名空间 → 依赖的模块）：

```
Di.Cli（docs/cli.md）
  ├─ Core.AgentLoop（docs/modules/agent-loop.md）    ← 会话契约 IAgentRunner
  │     ├─ Core.Llm（docs/modules/llm.md）           ← IChatModel / 重试 / 成本
  │     │     └─ Core.Providers.DeepSeek（docs/modules/deepseek.md） ← 唯一已实现厂商
  │     ├─ Core.Tools（docs/modules/tools.md）       ← IToolExecutor
  │     ├─ Core.Skills（docs/modules/skills.md）     ← ActiveSkills / load_skill
  │     ├─ Core.ContextManagement（docs/modules/context-management.md） ← L1 工具结果预算控制
  │     │       （组合根把执行器包一层 CompactingExecutor；BudgetPolicy / ArtifactStore）
  │     └─ Common.Events（docs/modules/events.md）   ← AgentLoopEvent 事件流
  └─ Core.Sessions（docs/modules/sessions.md）       ← SessionLog 落盘
       · 中断信号 IInterruptSignal 的实现（docs/interrupt.md）← 依赖倒置：Core.AgentLoop 只读信号，
         Di.Cli 提供实现（递进式软停止 / 硬取消 / 退出）
```

- 适配器只依赖 Core 抽象，宿主不认识任何具体厂商。
- 中断同理：`Core.AgentLoop` 依赖 `IInterruptSignal` 抽象，具体实现（`InterruptCoordinator`）在前端。
- 上下文压缩（阶段一）：`Di.Cli → Core.ContextManagement → Core.Llm（TokenEstimator）/ Core.Tools
  （CoreTools / OutputBuffer）`，持久化经 `Core.Configuration.DiHome` 解析 `~/.di` 根目录；
  `Core.AgentLoop → Core.ContextManagement` 的接线（AgentRunner 预算化改造，用 ContextManager 替代
  每轮丢最旧）随阶段二落地，见 `docs/modules/context-management.md`。
- 各模块的源码 / 测试目录见 `docs/modules/README.md`；一次回合的**运行时数据流时序**见下节 §4。

## 4. 一次回合的数据流（时序）

```
Repl.RunTurnAsync
  ├─ 创建 AgentLoopEvent 消费者，启动并发渲染任务
  ├─ 词法匹配 skills → AgentRunner.ActiveSkills = 固定 + 自动匹配
  ├─ AgentRunner.RunAsync(用户消息)
  │   ├─ 捕获环境快照（最小化：仅工作目录 + 自取提示，git 状态不注入）；有变化才追加为历史 system 消息
  │   ├─ 构建 SystemContext（skill 广告 + 激活 skill 指令）
  │   └─ ReAct.RunStreamingAsync(AgentRequest)
  │       └─ 循环：
  │           ├─ BuildContext = [systemPrompt] + [历史+用户消息] + [SystemContext]
  │           ├─ IChatModel.StreamAsync
  │           │   └─ RetryingChatModel → ChatModelClient → LlmRuntime → DeepSeekAdapter
  │           │       └─ SSE chunk → StreamChunk → ChatAssembler
  │           ├─ 每个流事件 → AgentLoopEvent（总线）→ 渲染任务实时输出；DiLog 旁路订阅写 ~/.di/logs
  │           │       （用户输入 run: started → llm: call_started → call_completed，见 docs/modules/logging.md）
  │           ├─ TurnCompleted（累计 usage）→ 事件总线
  │           ├─ 有工具调用 → IToolExecutor 执行 → 观察回填轨迹 → 下一轮
  │           └─ 无工具调用 → 返回 AgentResult（Answer/轨迹/用量/停止原因）
  ├─ 渲染最终结果（含用量脚注）
  └─ SessionLog.AppendTurn(结果, 开始时间) → JSONL 落盘
```

## 5. 关键设计决策

1. **适配器翻译线格式**：所有厂商怪癖只允许出现在适配器翻译层（`DeepSeekTranslator`），
   业务与宿主不认识具体厂商 —— 加厂商 = 加一个 DI 扩展 + 一个适配器（见 `docs/modules/llm.md` / `docs/modules/deepseek.md`）。
2. **消息词汇是内存内词汇**：`ChatMessage` / `IContentBlock` 是归一化的内存模型；
   线格式 DTO 由适配器各自私有，历史持久化由宿主用类型标签 + 注册表自行实现。
3. **reasoning 一等公民**：思考内容与可见文本分离存储、无损回放（带 tools 时缺它 DeepSeek 400）。
4. **缓存是字节精确前缀匹配**：请求里"稳定内容在前、易变内容在后 / 不入历史"；
   未设置的集合绝不序列化成空数组 —— 一切为 byte-identical prefix 服务（见 `docs/modules/agent-loop.md`）。
5. **事件总线解耦循环与 UI**：ReAct 只发事件不渲染，CLI 从总线消费；日志 / 遥测走同一总线
   （见 `docs/modules/events.md` / `docs/modules/logging.md`）。
6. **跨回合记忆由宿主管理**：ReAct 只拼装，AgentRunner 负责累加 / 裁剪 / 快照去重，
   loop 层保持无状态、可独立复用。
7. **失败是观察不是崩溃**：工具失败 → 错误观察文本回填模型；不可重试模型错误 → 干净结局。
8. **MVP 优先 + TDD**：每个模块最小可用先跑通，测试先行（红→绿），提交用 Conventional Commits
   （见根 `CLAUDE.md`）。
9. **模型是纯数据、鉴权是声明**：模型目录（Catalog）与认证声明（Auth）都是适配器上的数据，
   凭据存储（`ILlmCredentialStore`）由宿主注入、请求时才解析——加模型 / 换凭据来源零引擎改动。
10. **工具设计（schema 与说明互补、说明与 schema 同源、子集预留）**：`tools` 参数是机器可读的
    调用契约（能调什么、参数怎么填），工具使用说明（`CoreTools.BuildInstructions`）是注入稳定前缀的
    操作手册（观察约定、行为偏好、协议）——两者互补而非冗余。说明文本由每个工具自己的
    `PromptSnippet` / `PromptGuidelines` 贡献聚合（`Core/Tools/ICoreTool.cs`），与 schema co-locate、
    永不失配。工具集按 all/coding/read-only 组合预留扩展缝（当前只用全量，镜像 pi 的
    `https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/tools/index.ts` ），未来按场景暴露子集（只读模式 / 权限降级等）（见 `docs/modules/tools.md`）。
11. **UI 解耦走进程边界**：核心层不认识任何 UI；TS TUI（`tui/`）与 C# REPL 并列，
    都只消费 `IAgentRunner` + `AgentLoopEvent` 事件流（`--mode rpc` 序列化，见 `docs/tui-rpc.md`）。

## 关联文档

- `docs/modules/README.md` —— 核心模块索引（模块 ↔ 文档 / 源码 / 测试映射唯一权威）
- `docs/cli.md` —— CLI 层契约（`IAgentRunner` 会话驱动的边界）
- `docs/di-home.md` —— `~/.di` 家目录与配置规范
- `docs/roadmap.md` —— 功能全景、MVP 缺口、工业级路线图
- `docs/README.md` —— 文档总索引（怎么按需定位）
