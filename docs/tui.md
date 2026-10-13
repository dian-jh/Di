# Di 终端界面（TS TUI）：设计与架构

> 设计文档。回答"为什么把 UI 换成一个 TypeScript 项目、它和 C# 核心怎么解耦、分几步落地"。
> 核心主张：**核心层（`Core.AgentLoop`）与 UI 层通过进程边界解耦** —— TS TUI 作为前端，
> 以子进程方式驱动 `di --mode rpc`（C# 后端），两者只依赖一份 NDJSON 协议契约
> （唯一权威：`docs/tui-rpc.md`）。既有的 C# REPL 界面（`Di.Cli`）保留不动，与之并存。
>
> 参考实现：开源 `@earendil-works/pi-tui`（差分渲染 TUI 库，MIT）与其消费方
> `packages/coding-agent` 的"每回合一个 promise 输入循环 + 事件流驱动组件变更"模式。
>
> 配套文档：`docs/README.md`（总索引）、`docs/architecture.md`（依赖方向）、`docs/cli.md`
> （CLI 契约与跨语言重写指南）、`docs/tui-rpc.md`（协议唯一权威）、`docs/roadmap.md`。

---

## 1. 一句话定位

Di 新增一个 **TypeScript 终端前端**（仓库根 `tui/`），复用 npm 已发布的 `@earendil-works/pi-tui`
做差分渲染，通过子进程 + NDJSON over stdin/stdout 协议驱动 C# harness 核心；UI 与核心只认协议，
互不认识对方代码。这是 `docs/cli.md` §5"用另一语言重写 CLI"指南的首次落地（TypeScript 版 CLI）。

```
tui/ (TypeScript, Node ≥22.19)
   │  spawn di.exe --mode rpc（子进程，NDJSON 双向）
   ▼
Di.Cli --mode rpc（C# 后端，复用既有 CliHost 组合根与 AgentRunner）
   └──► Core ──► Common
（Di.Cli 既有 REPL 界面保留，作为另一个前端并存）
```

## 2. 动机

1. **终端体验**：现有 `Di.Cli/EventRenderer.cs` 只是"逐字符打印 + 两段 ANSI 控制序列"，
   无排版 / 滚动 / 工具卡片 / 思考展示。TS TUI 目标是对齐 pi / Claude Code 的聊天视口体验。
2. **核心与 UI 解耦**：`docs/cli.md` §5 已把"子进程 + stdin-stdout 协议"列为跨语言 CLI 的既定
   机制；`CliApp` 中 `AppMode.Rpc` 是**预留但未实现**的缝（`--mode rpc` 当前 exit 1）。
   TS TUI 正好把这条缝落地——**不触碰核心层，核心层本来就不认识 UI**（依赖方向
   `Di.Cli → Core → Common` 不变）。
3. **复用而非自研**：`@earendil-works/pi-tui` 是现成的高质量差分渲染 TUI 库（MIT，npm 1.2.0，
   engines node≥22.19），组件契约极简（`render(width): string[]` + `invalidate()`），不引入框架。

## 3. 关键设计决策

1. **跨进程契约即解耦面**：核心对外的稳定运行时面只有两个（`docs/cli.md` §2）——
   `IAgentRunner.RunAsync(string) → AgentResult`（每回合一次调用）与
   `IEventBus.CreateConsumer<AgentLoopEvent>()`（事件 pull 流）。`--mode rpc` 把这两个面
   序列化为 NDJSON（事件逐条流出、回合终了发 result），TS TUI 只消费协议，不感知 C# 类型。
2. **事件保真补齐**：`ReAct.StreamModelAsync` 目前把 `ModelEvent.ReasoningDelta` /
   `ToolCallDelta` **丢弃**（`Core/AgentLoop/ReAct.cs`）。新增
   `AgentLoopEvent.ReasoningDelta(string)` / `ToolCallDelta(id, name, arguments)` 并把它们
   转发到事件总线——TS TUI 才能展示思考与实时工具参数（既有 EventRenderer 对新增类型天然忽略，
   需测试确认）。事件类型表唯一权威 `docs/modules/events.md` 同步更新。
3. **回合语义上移到 TUI**：turn 边界（消费者创建 / 排空、interrupt 首退回合 / 再退退出）目前
   在 `Di.Cli/Repl.cs`。RPC 模式下这些语义由 TS TUI 拥有；后端无状态、串行处理请求，
   Ctrl+C 由 TUI 捕获并翻译成 `interrupt` 请求（后端取消当前回合 → `stop_reason: "cancelled"`）。
4. **MVP 用主屏（inline）**：先落 `TuiMainScreen`（常规模式，随终端滚动），不依赖 alt-screen
   布局引擎；聊天视口（transcript ScrollView + dock）留到 M2 全屏化。MVP 聚焦端到端跑通：
   流式文本、工具生命周期、输入、中断。
5. **依赖已发布包**：`@earendil-works/pi-tui@^1.2.0`（npm 官方包，比本地 PI 仓库 1.1.0 新），
   不 fork、不 vendor、不依赖本地 `E:\Agent\PI` 检出。win32 剪贴板等走包内预编译 N-API 二进制。
6. **会话日志仍由后端落盘**：`SessionLog.AppendTurn` 在 RpcMode 宿主内执行（复用 `CliHost` 的
   `SessionLog`），TUI 不关心持久化；`--no-session` 语义保留。

## 4. 模块结构（`tui/`，相对仓库根）

```
tui/
├── package.json            # type:module；deps: @earendil-works/pi-tui@^1.2.0；engines node>=22.19
├── tsconfig.json
├── src/
│   ├── main.ts             # 入口：解析自身参数 → spawn di --mode rpc → 装配视图 → 事件循环
│   ├── rpc/
│   │   ├── protocol.ts     # 协议类型定义（与 docs/tui-rpc.md 逐字段对应）
│   │   ├── codec.ts        # NDJSON 编解码（行帧、parse/validate、FIFO 队列）
│   │   └── client.ts       # 子进程管理：spawn、ready 握手、请求方法、事件订阅、退出清理
│   └── app/
│       ├── state.ts        # 回合状态机（idle/running/cancelling）→ 事件映射为视图变更
│       ├── chat-view.ts    # 聊天视口：transcript(ScrollView) + dock(状态行 + 提示输入)
│       ├── message.ts      # 用户/助手消息组件（Markdown/Text + 流式追加）
│       └── tool-call.ts    # 工具调用组件（标题行 + 结果，M2 再做折叠/展开）
└── test/                   # node --test：codec 往返、状态机（不依赖终端）
```

- 找 `di` 二进制顺序：环境变量 `DI_BIN` → PATH 上的 `di` → `~/.di/bin/di.exe`（win32）。
- 构建 / 运行：`npm install` → `npm run build`（tsc）→ `npm start`。

## 5. 里程碑（分阶段，MVP 优先）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M1**（本任务） | C# `--mode rpc` 后端 + reasoning/toolcall 事件转发；TS TUI MVP（inline 聊天：流式文本、工具行、提示输入、Ctrl+C 中断） | 进行中 |
| M2 | 全屏 alt-screen 视口（transcript ScrollView + dock）、工具折叠 / 展开、skills 展示、Markdown 主题 | 待办 |
| M3 | 状态栏（模型 / 成本 / tokens）、`/tui` 主屏/全屏切换、斜杠命令 UI、编辑器增强（补全 / 粘贴） | 待办 |
| M4 | 安装整合（`install.*` 一并构建 TS）、根 `README.md` 用户视图、`di tui` 子命令 | 待办 |

## 6. 验收信号（M1）

- `dotnet test Di.Tests Di.Cli.Tests` 全绿（含新增 RpcMode 测试）。
- 管道喂入 `di --mode rpc` 一条 `prompt` 请求 → stdout 依次出现 `ready`、事件流、`result`，
  `stop_reason` / usage / cost 与 `--mode json` 一致；`interrupt` 取消回合 → `cancelled`。
- `npm test`（tui/）全绿；`npm start` 能起 TUI，输入提示词后流式渲染、Ctrl+C 取消回合、再次退出。

## 关联文档

- `docs/tui-rpc.md` —— 线协议契约（**唯一权威**，双端实现据此对齐）
- `docs/cli.md` —— CLI 契约（`--mode rpc` 落点、跨语言重写指南）
- `docs/modules/events.md` —— 事件类型表（新增 reasoning/tool_call delta 后同步）
- `docs/architecture.md` —— 依赖方向总览
- `docs/roadmap.md` —— 路线图（M1–M4）
