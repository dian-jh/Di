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
   机制；`CliApp` 中 `AppMode.Rpc` 已通过 `Di.Cli/modes/RpcMode.cs` 实现。
   TS TUI 通过该后端复用核心（依赖方向
   `Di.Cli → Core → Common` 不变）。
3. **复用而非自研**：`@earendil-works/pi-tui` 是现成的高质量差分渲染 TUI 库（MIT，npm 1.2.0，
   engines node≥22.19），组件契约极简（`render(width): string[]` + `invalidate()`），不引入框架。

## 3. 关键设计决策

1. **跨进程契约即解耦面**：核心对外的稳定运行时面只有两个（`docs/cli.md` §2）——
   `IAgentRunner.RunAsync(string) → AgentResult`（每回合一次调用）与
   `IEventBus.CreateConsumer<AgentLoopEvent>()`（事件 pull 流）。`--mode rpc` 把这两个面
   序列化为 NDJSON（事件逐条流出、回合终了发 result），TS TUI 只消费协议，不感知 C# 类型。
2. **事件保真**：`ReAct.StreamModelAsync`（`Core/AgentLoop/ReAct.cs`）已将模型的推理与工具参数增量
   转为 `AgentLoopEvent.ReasoningDelta` / `ToolCallDelta`，经事件总线和 RPC 转发到 TUI。
   事件类型见 `docs/modules/events.md`；文本渲染由 `Di.Cli/EventRenderer.cs` 按终端模式处理。
3. **回合语义上移到 TUI**：turn 边界（消费者创建 / 排空、interrupt 首退回合 / 再退退出）目前
   在 `Di.Cli/Repl.cs`。RPC 模式下这些语义由 TS TUI 拥有；后端无状态、串行处理请求，
   Ctrl+C 由 TUI 捕获并翻译成 `interrupt` 请求（后端取消当前回合 → `stop_reason: "cancelled"`）。
   递进式软停止（先退回合 / 再退退出）的完整语义见 `docs/interrupt.md`；TUI 侧接线见其 §7。
4. **全屏视口（alt-screen）落地（M2 先行）**：聊天采用 pi coding-agent `createChatViewport` 同构的
   全屏布局 —— `root = VStack[transcript ScrollView(follow end, grow) + dock(basis auto)]`，输入框固定
   dock 在终端底部（`tui/src/app/chat-layout.ts`），内容再多也不会把输入框顶出屏幕；滚轮 / PgUp / PgDn
   滚动与「↓ 最新消息」跳底由 `TuiAltScreen` 内置。MVP 早期曾用 `TuiMainScreen`（inline 随终端自然
   滚动），但 transcript 超过屏幕后输入框随文档流离开视口——本变更据此弃用。`/tui` 主屏/全屏切换留待
   M3。
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
│       ├── state.ts        # 回合状态机（idle/running/cancelling）+ 会话元数据（模型/强度/skills/models）
│       ├── chat-view.ts    # 聊天视口：transcript + 错误横幅 + 输入框 + 输入框下状态行，装载到全屏布局根
│       ├── chat-layout.ts  # 全屏布局装配（纯函数）：root = VStack[transcript ScrollView + dock]，输入框后固定状态行
│       ├── badge.ts        # 输入框下方独立徽标行（右对齐，不与输入框同处一行；委托鼠标/键盘）
│       ├── terminal-mode.ts# 终端模式检测：经典 conhost（cmd）vs 现代终端（WT/TERM_PROGRAM/ConEmuANSI）
│       ├── message.ts      # 用户/助手消息组件（用户输入整行灰底）
│       ├── rule.ts         # 浅灰框线（消息分隔 / 用户条形框 / 输入框边框，颜色可配）
│       ├── commands.ts     # 斜杠命令文本解析 + skill: 前缀归一（纯函数，可单测）
│       └── tool-call.ts    # 工具调用组件（标题行 + 结果，M2 再做折叠/展开）
└── test/                   # node --test：codec 往返、状态机（不依赖终端）
```

- 找 `di` 二进制顺序：环境变量 `DI_BIN` → PATH 上的 `di` → `~/.di/bin/di.exe`（win32）。
- 构建 / 运行：`npm install` → `npm run build`（tsc）→ `npm start`。

## 5. 里程碑（分阶段，MVP 优先）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M1** | C# `--mode rpc` 后端 + reasoning/toolcall 事件转发；TS TUI MVP（流式文本、工具行、提示输入、Ctrl+C 中断） | 已实现 |
| M2 | 全屏 alt-screen 视口（transcript ScrollView + dock）、工具折叠 / 展开、skills 展示、Markdown 主题 | 部分实现：全屏 alt-screen 视口使用 transcript ScrollView（follow end，滚轮 / PgUp / PgDn 滚动、`↓ 最新消息`跳底；无滚动条）与固定 dock（`tui/src/app/chat-layout.ts`）。所有终端使用同一全屏布局。剩余：工具折叠 / 展开、skills 展示、Markdown 主题 |
| M3 | 状态栏（模型 / 成本 / tokens）、`/tui` 主屏/全屏切换、斜杠命令 UI、编辑器增强（补全 / 粘贴） | 部分就绪：命令注册表与 RPC `command` 方法见 `docs/tui-rpc.md` §2.5/§3。TUI 使用 `Editor` 斜杠菜单与参数补全；`ready` / `command_ran` 更新模型元数据。状态行固定在输入框下方，左侧显示累计 cache 命中率与 cost，右侧显示纯模型名。用户消息为整行灰底并用 `>` 标记；回合不再绘制重复输入标题，折叠导航仍保留。剩余：`/tui` 切换与粘贴增强 |
| M4（本变更） | 安装整合（`install.*` 构建 TS 并复制到 `~/.di/tui/`）、`di` 交互默认启动 TUI（`node <entry>` 继承控制台；`DI_UI=repl` 逃生门回退 REPL）、根 `README.md` 用户视图 | **已实现**（`di tui` 显式子命令仍待办） |

### TUI 展示行为（`tui/src/app/`）

- 用户消息以 `>` 前缀显示为整行 `#373737` 灰底浅色文字，包含 CJK 与换行内容；助手正文使用 `@earendil-works/pi-tui` 的 `Markdown` 组件增量更新。状态行固定在输入框下方，左侧显示 Cache/Cost，右侧仅显示模型名。历史回合不重复显示用户输入标题，折叠导航键仍可用。
- 可见内容块之间由 `tui/src/app/spacing.ts` 的 `SpacedBlock` 插入一行普通背景留白：用户灰条与思考/工具/答案、思考展开内容与后续工具/答案、相邻回合之间至少一行；空组件不占行，流式更新重用同一组件而不会累积空行。间隔行不会继承用户灰底，也不改变 Markdown 内部排版。
- 标准 `diff` fenced block 中新增行使用绿色背景、删除行使用红色背景（跳过 `+++` / `---` 文件头）；普通代码块和正文行不按首字符染色。
- 工具卡片默认折叠，仅显示名称、状态与 UI 实测耗时；参数和结果在展开后显示。通过点击或逐项快捷键可展开；思考区也默认折叠并显示 UI 实测耗时。历史按回合分组，各组独立折叠。`Alt+Up` / `Alt+Down` 遍历各可折叠项，`Ctrl+Enter` 切换选中项；现代终端提供 ScrollView 鼠标与翻页滚动，经典 conhost 由系统 scrollback 负责滚轮并支持键盘快捷键。
- `/usage` 展示会话累计 input/output/total/cache_read/cache_write/reasoning、cache 命中率与费用，并将协议未提供的当前上下文用量显示为 `N/A`。正常累计采纳 `result` 回合终值；synthetic zero usage（取消或错误）使用最近的 `turn_completed` 累计快照。缺失的 cache/cost 子字段不会按零伪造完整统计。命中率与 `Core/Llm/TokenUsage.CacheHitRate` 对齐：`cache_read / (input + cache_read + cache_write)`，分母中缺少的可选 cache-write 按 0 处理；cache-write 单项展示仍为 `N/A`，cache-read 缺失则整体命中率为 `N/A`。实现见 `tui/src/app/state.ts` 的 `TurnStateMachine.usageSummary()` / `finishTurn()` / `onTurnCompleted()`。
- 折叠键盘操作：`Alt+Up` / `Alt+Down` 在历史回合、思考区、工具卡片间逐项选择，`Ctrl+Enter` 切换选中项；`Ctrl+Up` / `Ctrl+Down` 选择历史回合，`Ctrl+O` / `Ctrl+R` / `Ctrl+T` 提供快速切换。全局快捷键不夺走输入框焦点；鼠标点击只触发展开/折叠。
- 新增交互应先在 `tui/test/` 写失败测试，再实现；Node 测试入口为 `cd tui && npm test`，构建为 `cd tui && npm run build`。

## 6. 验收信号（M1）

- `dotnet test Di.Tests Di.Cli.Tests` 全绿（含新增 RpcMode 测试）。
- 管道喂入 `di --mode rpc` 一条 `prompt` 请求 → stdout 依次出现 `ready`、事件流、`result`，
  `stop_reason` / usage / cost 与 `--mode json` 一致；`interrupt` 取消回合 → `cancelled`
  （软停止 → `interrupted`，见 `docs/interrupt.md`）。
- `npm test`（tui/）全绿；`npm start` 能起 TUI，输入提示词后流式渲染、Ctrl+C 取消回合、再次退出。

## 关联文档

- `docs/tui-rpc.md` —— 线协议契约（**唯一权威**，双端实现据此对齐）
- `docs/cli.md` —— CLI 契约（`--mode rpc` 落点、跨语言重写指南）
- `docs/modules/events.md` —— 事件类型表（新增 reasoning/tool_call delta 后同步）
- `docs/architecture.md` —— 依赖方向总览
- `docs/roadmap.md` —— 路线图（M1–M4）
