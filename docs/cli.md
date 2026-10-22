# CLI 层契约：harness 与会话驱动的边界

> 设计文档。回答"CLI 层为什么这么分层、哪部分可以换语言重写、重写时保留什么"。
> 核心主张：**会话驱动 API 在 harness 层，CLI 负责参数、模式、组合与渲染**。本文 C# 类型和路径是迁移基线参考，TS 当前源码入口在 §7 前列出。
> 参考实现：Pi 的 `main.ts → resolveAppMode → 模式执行器` 结构
> （外部参考：兄弟仓库 `https://github.com/earendil-works/pi/tree/main/packages/coding-agent`）。
>
> 配套文档：`docs/README.md`（总索引）、`docs/architecture.md`（架构与关键决策）、
> `docs/roadmap.md`（能力全景与路线图）。

---

## 1. 分层一句话

| 层 | 位置 | 职责 | 换语言时 |
|---|---|---|---|
| **harness 契约**（稳定，复用） | `packages/agent/`、`packages/ai/`、`packages/coding-agent/` | 驱动一个回合、事件流、结果、工具、模型 | TS 实现；C# 基线供差异核对 |
| **CLI 宿主** | `packages/coding-agent/src/cli/` | 参数解析、模式选择、组合根、渲染、进程退出码 | TS 实现；默认安装入口仍受发布门槛约束 |

任何语言的 CLI 都只做三件事：**解析参数 → 决定模式 → 用同一个会话 API 跑并渲染**。
参数与模式的解析是纯函数（无 I/O），因此规则可以（也应该）在另一种语言里原样复刻。

当前 TS 宿主使用 `AgentSession`、共享命令注册表、`EventBus` 和 `SessionStore`；交互、headless 与 RPC 模式代码位于 `packages/coding-agent/src/modes/`。C# 旧宿主仍保留作迁移参考。

---

## 2. harness 侧稳定契约（换语言时"调用"它）

这是 CLI 唯一依赖的运行时面。三种语言的 CLI 都要通过它们驱动同一个会话。

### 2.1 会话驱动 —— `IAgentRunner`（`Core/AgentLoop/IAgentRunner.cs`）

```csharp
public interface IAgentRunner
{
    string CurrentModel { get; set; }              // /model 切换、-m 覆盖
    IReadOnlyList<Skill> ActiveSkills { get; set; } // 固定 + 自动匹配，可叠加
    IInterruptSignal? InterruptSignal { get; set; } // 软停止信号（前端注入，可空）；见 docs/interrupt.md
    Task<AgentResult> RunAsync(string userMessage, CancellationToken ct = default);
    void ResetHistory();                            // /clear：清空跨回合记忆
}
```

一次 `RunAsync` = 一个完整回合：环境快照进历史 → ReAct 循环 → 事件经总线发布 → 返回结果。
CLI 不感知 ReAct 内部，只消费事件流与最终结果。

### 2.2 事件流 —— `AgentLoopEvent`（`Common/Events` + `Core/AgentLoop/AgentLoopEvent.cs`）

运行中的事件经 `IEventBus`（`Common.Events`）发布，UI 从同一总线消费。事件是**拉式**（channel）或**推式**（订阅）均可；headless 文本模式用拉式流式渲染，json 模式根本不消费。

> 事件类型 / 负载 / 含义的**唯一权威表**见 `docs/modules/events.md` §关键符号，此处不复述。
> 换语言契约视角：CLI 依赖的事件流有「流式文本增量」「推理增量」「工具调用增量」「工具生命周期」
> 「回合结束（用量 / 成本 / 停止原因）」「循环失败」「回合中断（软停止）」七类，
> 字段细节以 `docs/modules/events.md` 为准（推理 / 工具调用增量为 M1 新增，供 TUI 展示思考与实时工具参数；
> `Interrupted` 见 `docs/interrupt.md`）。

### 2.3 结果 —— `AgentResult`（`Core/AgentLoop/AgentResult.cs`）

```csharp
class AgentResult
{
    string Answer;                              // 最终可见文本
    IReadOnlyList<ChatMessage> Trajectory;      // 完整轨迹（可重放）
    TokenUsage Usage;                           // 累计 tokens
    UsageCost? Cost;                            // 累计成本（无费率时 null）
    int Iterations;                             // 实际轮数
    AgentStopReason StopReason;                 // Answer / FinalOutputTool / MaxIterations / ContextLimit / Error / Interrupted
    LlmFailure? Failure;                        // StopReason==Error 时的故障事实
}
```

---

## 3. CLI 薄壳（可整体重写）

### 3.1 一次调用的旅程（`CliApp.RunAsync`）

```
string[] args
  → CliArgsParser.Parse(args)         纯函数：args → CliArgs + 诊断（未知旗标/缺值/非法模式）
  → 诊断有 error ? 打 stderr + exit 1
  → CliMode.Resolve(args, stdinTty, stdoutTty)   纯函数：决定 AppMode
  → 短路径（Version/Info/Help/Stats）直接输出退出，不建 DI
  → CliHost.Create(...)               组合根：配置 → AddDi → 工具/skills/runner/会话日志
  → 分派：Interactive → TS TUI（`node <entry>`，回退 Repl，见 §3.4）；Print/Json → PrintMode；
          ListModels → 列目录；Stats → 聚合会话；SkillEval → 评估匹配器；
          Rpc → RpcMode（NDJSON 会话驱动后端，见 docs/tui-rpc.md）
```

### 3.2 纯数据与纯函数（语言无关，建议他语言原样复刻）

- **`CliArgs`**（`Di.Cli/cli/CliArgs.cs`）：`Positionals`、`Model`、`Provider`、`Print`、`Mode`、
  `Version`、`Info`、`Help`、`ListModels`、`Stats`、`SkillEval`、`Thinking`、`Resume`、`NoSession`、`NoAnsi`、`UnknownFlags`。
  规则：`--` 后全为位置参数；带值旗标缺值报错；`--list-models [pattern]` 可选吃下一个非旗标 token；
  `--stats <file>` / `--skill-eval <file>` 必选吃下一个非旗标 token（缺值报错）；
  `--mode` 值域 `interactive/print/json/rpc`；未知旗标记入 `UnknownFlags` 并报错（不静默忽略）。
- **会话恢复**：`di --resume <file>` 在首次交互输入前校验并加载 checkpoint；若没有显式 `--mode` 且无位置参数则进入 REPL 并跳过 TUI。用户输入后才继续模型调用。JSON / print 模式按原模式解析，兼容 `di --mode json --resume <file> 继续`；恢复错误为 stderr + exit 1，JSON 模式 stdout 输出一个 `session_resume` error。旧版没有 checkpoint 的日志明确拒绝；可用更大上下文预算继续超窗任务。未知工具执行结果要求核查后启动新会话，禁止自动重放。
- **默认长程循环**：`AgentLoop:MaxIterations` 默认 `0`（不限轮数），设置正整数才启用显式预算。模型调用前会检查完整请求估算；超预算返回 `ContextLimit`（JSON: `context_limit`），完整轨迹 checkpoint 保留。换用更大上下文预算/模型后输入“继续”可重试；超长轨迹目前没有自动摘要，若仍放不下需另开任务提炼状态。该估算不是 tokenizer 精算；模型上下文窗口未知时无请求级保护。
- **`CliMode.Resolve(CliArgs, stdinTty, stdoutTty)`**（`Di.Cli/cli/CliMode.cs`）：

| 条件 | 模式 |
|---|---|
| `--version` / `--info` / `--help` | 对应短路径（优先，直接输出退出，不建 DI） |
| `--list-models` | ListModels（仍建宿主，列出模型目录） |
| `--stats <file>` | Stats（短路径：聚合会话 JSONL 后退出，不建 DI） |
| `--skill-eval <file>` | SkillEval（仍建宿主，用与生产一致的 skills 评估匹配器） |
| `--mode json` | Json |
| `--mode print` | Print |
| `--mode interactive` | Interactive |
| `--mode rpc` | Rpc |
| 位置参数 > 0 | Print（`di "提示词"`） |
| `--print` 或 stdin/stdout 非 TTY | Print（`echo x | di`） |
| 否则 | Interactive |

### 3.3 组合根 —— `CliHost`

配置分层（`Di.Cli/appsettings.json → ~/.di/config.json → <workspace>/.di/config.json → 环境变量`）→
`AddDi()` 装配模型层与事件总线 → 工具执行器、skills、`SessionLog`、`AgentRunner`。
CLI 参数里的覆盖项在此生效：`--provider` 换适配器路由、`--model` 换默认模型、`--thinking` 透传。
API Key 不在启动时要求 —— 凭据由模型层在**请求时**解析，未配置时仅请求路径报错。

### 3.4 渲染与进程边界

- `CliApp` **不碰 `Console`**：输入输出流与 TTY 探测全部由 `Di.Cli/Program.cs` 传入
  （`Console.In/Out/Error`、`!Console.IsInputRedirected/IsOutputRedirected`），因此可测、可嵌入任意宿主。
- `Di.Cli/Program.cs` 固定 `Console.OutputEncoding/InputEncoding = UTF-8`：控制台代码页可能是 GBK(936)，
  不显式设置时中文按代码页编码，在管道/脚本/UTF-8 终端里乱码。
- **回合级 Ctrl+C（递进式）**（`Di.Cli/InterruptCoordinator.cs`，`Program.cs` 注册 `Console.CancelKeyPress`）：
  交互 REPL 中**第一次** Ctrl+C = **软停止**（置位 `IInterruptSignal`，回合在下一个相位边界优雅收敛，
  以 `StopReason.Interrupted` 正常返回、保留已写入会话，提示后继续），**第二次** = **硬取消**当前回合
  （杀在途模型流 / 子进程），**空闲时** Ctrl+C 退出进程；headless 下 Ctrl+C 仍直接退出。
  完整语义与状态机见 `docs/interrupt.md`。
- **交互前端：TS TUI 为默认（M4）**：交互模式（双 TTY）默认把控制台交给 TS TUI ——
  `node <entry>` 子进程，**继承 stdio（不重定向，TUI 拥有控制台）**，等待退出并把其退出码原样返回。
  判定与逃生门实现在 `Di.Cli/TuiLauncher.cs`：
  <br>① 逃生门：环境变量 `DI_UI=repl`（**精确**匹配；任何其他值或未设置 → 走 TUI 路径）；
  <br>② 入口：环境变量 `DI_TUI`（一个 JS 入口文件，或一个含 `dist/main.js` 的目录）；
  未设置时默认 `~/.di/tui/dist/main.js`（win32 用 `USERPROFILE`→`HOME`）；
  <br>③ 依赖：`node` 可在 PATH 上解析（spawn `node --version` 探测）；
  <br>④ 回退：入口缺失 / 无 node / spawn 异常或**非零退出** → stderr 一行提示原因
  （如"未找到 TUI 入口（…），回退 REPL"）并回退旧 C# REPL。
  安装：`install.cmd` / `install.ps1` 构建 `tui/`（`npm ci` + `npm run build`）并复制
  `dist/`、`package.json`、`node_modules/` 到 `~/.di/tui/`；node/npm 缺失或构建失败只告警
  （"TUI 不可用，回退 REPL"），**不失败** —— di.exe 单独仍可用。headless 各模式与本文档 §4
  **完全不变**，不受 TUI 影响。
- 退出码：`0` = 成功；`1` = 用法错误 / 运行错误（模型不可用等）。脚本以退出码判成败。

---

## 4. Headless 契约（脚本 / CI 依赖它）

### 4.1 文本模式（默认 / `--mode print`）

事件流式渲染到 stdout（无 ANSI；TTY 下回合开始时先显示"正在请求模型…"状态行，首个输出到达后不再出现；
管道/重定向时省略，保持捕获输出干净），结果脚注；`--no-ansi` 进一步禁控制序列。
**思考渲染**：TTY 下模型思考期（DeepSeek 先流 ~1s reasoning 再流回答）以"── 思考中 ──"块实时渲染，
消除"等好几秒无输出"的死屏（`EventRenderer.ReasoningDelta`，仅真实终端开启）；管道/重定向省略，
推理全文在会话 JSONL；JSON 模式不渲染（单文档契约）。
会话日志写入 `~/.di/sessions/`（`--no-session` 关闭 checkpoint 与审计日志）；`--resume <file>` 恢复 checkpoint 文件。
**迭代预算耗尽兜底**：`StopReason == MaxIterations` 时（`EventRenderer.RenderResult`）在脚注前补打印
"已达迭代上限，任务可能未完成"与模型最后一段输出（`AgentResult.Answer`），避免"跑完没结果"；
JSON 模式 `stop_reason` 为 `max_iterations`，脚本据此判断。
**软停止兜底**：`StopReason == Interrupted` 时（`EventRenderer.RenderResult`）打印一行"已中断：未开始的工作不再执行"
（模型已流出的文本不重复回显）；JSON 模式 `stop_reason` 即 `interrupted`，**退出码 0**（软停止是正常收敛，
非失败）。见 `docs/interrupt.md`。
与 REPL 同一共享计算（`Core/Skills/SkillActivation.cs` 的 `SkillActivation.Compute`，见 `docs/modules/skills.md`）做 skill 自动匹配：
提示词命中 skill 描述时完整指令注入系统上下文，未命中的只广告（headless 输出不额外打印激活信息，
保持脚本友好）。

### 4.2 JSON 模式（`--mode json`）

stdout 只输出**一个** JSON 文档（snake_case，可空键省略）：

```json
{ "answer": "...", "stop_reason": "answer", "iterations": 1,
  "usage": { "input_tokens": 10, "output_tokens": 20 }, "cost": 0.001234 }
```

失败时输出 `{"error": {"code": "usage|model_error|missing_credential|...", "message": "..."}}`
且退出码 1 —— 脚本可解析错误文档，不必吞 stderr。

---

## 5. 用另一语言重写 CLI 的指南

目标场景：CLI 换 Go / Rust / Python，harness（会话驱动）仍留在现有实现。

> 首次落地：仓库根 `tui/`（TypeScript TUI）是本指南的第一次具体重写 —— C# 后端以
> `--mode rpc` 子进程方式被新前端驱动。设计见 `docs/tui.md`，进程边界协议唯一权威
> `docs/tui-rpc.md`；事件保真补齐（推理 / 工具调用增量转发）在 `Core/AgentLoop/ReAct.cs`。

1. **保留**：`Core.AgentLoop`（`IAgentRunner` / 事件流 / `AgentResult`）与模型层。新 CLI 通过
   进程边界调用它们（子进程 + JSON-RPC / stdin-stdout 协议），或绑定到同一库（若新语言是 .NET 兼容）。
   会话 API 已经是"一回合 = 一次调用 + 事件流 + 结果"的契约，天然适配进程边界。
2. **复刻**：`CliArgsParser` 与 `CliMode.Resolve` 的规则（纯函数，直接照抄语义）。
3. **重写**：`CliApp` 分派、`CliHost` 组合根（配置读取）、`PrintMode` / `Repl` 渲染、安装分发。
   新语言应同样：短路径不建运行时、headless 文本/JSON 单发、退出码 0/1、UTF-8 输出。
4. **契约不变**：JSON 输出文档形状、退出码语义、`--mode` 值域 —— 这些是外部可观测接口，改了会破坏脚本。

---

## 6. 测试契约

| 关注点 | 测试文件 | 覆盖 |
|---|---|---|
| 参数解析（纯） | `Di.Cli.Tests/cli/CliArgsTests.cs` | 各旗标、`--` 截断、未知/缺值/非法模式 |
| 模式解析（纯） | `Di.Cli.Tests/cli/CliModeTests.cs` | TTY 组合 × 提示词 × `--mode`，短路径优先 |
| 分派壳 | `Di.Cli.Tests/cli/CliAppTests.cs` | 短路径不建 DI；list-models / 交互经 fake 宿主 |
| headless | `Di.Cli.Tests/modes/PrintModeTests.cs` | 文本/JSON、stdin、会话日志、全部失败路径 |
| TUI 启动与回退 | `Di.Cli.Tests/TuiLauncherTests.cs` | `DI_UI=repl` / 入口缺失 / 目录入口 / node 缺失不 spawn / spawn 退出码传播 / 异常与非零退出回退 |
| 会话驱动（harness） | `Di.Tests/AgentLoop/AgentRunnerTests.cs` | 模型路由、历史裁剪、快照、skills |

## 7. 当前 TypeScript 实现入口

| 能力 | 代码（仓库根相对路径） | 说明 |
|---|---|---|
| 参数/模式/分派 | `packages/coding-agent/src/cli/args.ts`, `mode.ts`, `cli-app.ts` | 纯解析与应用分派 |
| 组合根与模型选择 | `packages/coding-agent/src/cli/cli-host-compose.ts`, `cli-host.ts`, `core/model-selection.ts` | `createCliHost` 装配会话、工具、配置与 provider runtime |
| 会话与回合配置 | `packages/coding-agent/src/core/agent-session.ts`, `modes/turn-runner.ts` | 动态 token budget、history、maxIterations/maxTokens/reasoning effort |
| REPL / headless / RPC | `packages/coding-agent/src/modes/repl.ts`, `print-mode.ts`, `json-mode.ts`, `rpc-mode.ts` | 交互与无头模式；RPC 线协议见 `docs/tui-rpc.md` |
| 命令、会话、日志 | `packages/coding-agent/src/core/commands/`, `packages/coding-agent/src/core/sessions/`, `packages/coding-agent/src/core/logging/` | 共享 slash commands、checkpoint JSONL 与运行日志 |
| CLI 测试 | `packages/coding-agent/test/cli/`, `packages/coding-agent/test/modes/` | 组合根与模式行为覆盖 |

这些路径描述 TS 当前实现；未通过的发行/平台 gate 不由文件存在性代替。下表是 C# 基线落点，供行为参考。

## C# 基线实现现状（Di.Cli 参考落点）

> 各能力的"能力 → 落点 → 测试"完整对应见模块文档 `docs/modules/agent-loop.md`（循环侧）与
> `docs/modules/events.md`（事件侧）。下表是 Di.Cli 自身的实现落点（相对仓库根）。

| 能力 | 代码（相对仓库根） | 说明 |
|---|---|---|
| REPL 外层循环 | `Di.Cli/Repl.cs` | 读行 → 斜杠命令 → 回合；回合事件实时渲染 + 兜底排空 |
| 流式渲染 | `Di.Cli/EventRenderer.cs` | 逐字输出；工具调用 / 思考轮 / 用量+成本脚注；ANSI 状态行（重定向自动禁用）；MaxIterations 预算耗尽时补打印模型最后输出 |
| 斜杠命令分发 | `Di.Cli/Repl.cs`（`RunCommandAsync`） | 走 `SlashCommandRegistry` 分发（内置 + 用户命令）；回合型命令返回 `CommandResult.Turn` 由 REPL 回合机制执行；`/help` 由注册表推导 |
| 命令注册表 | `Di.Cli/Commands/`（`SlashCommand` / `SlashCommandRegistry` / `CommandContext` / `CommandResult`） | 对齐 Pi 的 `SlashCommands` 服务：`name/description/argumentHint/handler` 注册、按名解析、重名抛异常；REPL 与 `--mode rpc` 前端共用同一份（挂在 `CliHost.Commands`） |
| 内置命令 | `Di.Cli/Commands/BuiltinCommands.cs` | `/help` `/clear` `/model` `/thinking [强度或default]` `/usage` `/skills` `/skill` `/skill <名> <参数>` `/exit`（模式无关，只经 `CommandContext` 访问能力） |
| 用户命令（`~/.di/commands/*.md`） | `Di.Cli/Commands/CommandMarkdown.cs` + `CommandLoader.cs` | 扁平文件，命令名 = 文件名；frontmatter `description`（必填）/ `argument-hint`（可选）+ 正文指令模板；运行 = 正文 + 参数跑一个回合；无效/重名告警跳过 |
| RPC 命令方法 | `Di.Cli/modes/RpcMode.cs`（`HandleCommandAsync`） | `command` 请求：`list` 列注册表、`run` 执行同步命令；回合型命令返回 `command_error: turn_not_supported` 并携带 `turn_message`，TUI 随后用 `prompt` 执行（协议见 `docs/tui-rpc.md` §2.5/§3） |
| 回合级 Ctrl+C | `Di.Cli/InterruptCoordinator.cs` + `Di.Cli/Program.cs` | 回合内首次软停止、再次硬取消；headless/空闲直接退出（见 §3.4） |
| 纯参数解析（语言无关契约） | `Di.Cli/cli/CliArgs.cs` | `string[] → CliArgs` 纯数据 + 诊断；`--` 截断、未知 / 缺值 / 非法模式报错 |
| 纯模式解析 | `Di.Cli/cli/CliMode.cs` | `Resolve(args, stdinTty, stdoutTty)`；短路径优先（version/info/help 直接输出不建 DI；list-models 仍建宿主） |
| 环境 / 生效配置诊断 | `Di.Cli/CliApp.cs`（`InfoAsync`） | `di --info` 打印版本 / 构建时间 / 配置源存在性 / 生效 MaxIterations、模型、provider（含 CLI 覆盖标注）；短路径不建 DI，专治"装的二进制是不是旧的" |
| TUI 启动与回退 | `Di.Cli/TuiLauncher.cs` | 交互前端抉择：`DI_UI=repl` 逃生门 → `DI_TUI`（文件 / 含 dist/main.js 的目录）?? `~/.di/tui/dist/main.js` 入口解析 → node 探测（spawn `node --version`）→ spawn `node <entry>` 继承 stdio 等待退出；入口缺失 / 无 node / spawn 异常或非零退出 → 返回原因并回退 REPL（可测：env / 入口 / node / spawn 全注入） |
| 分派壳 | `Di.Cli/CliApp.cs` | 解析 → 校验 → 模式 → 建宿主 → 分派；不碰 Console（流与 TTY 由调用方注入）；交互模式先交 TS TUI（见上），不可用时回退 REPL |
| 会话统计 | `Di.Cli/CliApp.cs`（`StatsAsync`）+ `Core/Sessions/SessionStats.cs` | `di --stats <file>` 聚合回合数 / token 用量 / 缓存命中率 / 成本（离线，不建宿主） |
| skill 匹配评估 | `Di.Cli/CliApp.cs`（`SkillEvalAsync`）+ `Core/Skills/SkillCaseLoader.cs` | `di --skill-eval <cases.json>` 输出精确率 / 召回率 / 无匹配率 / 上下文成本 |
| 组合根 | `Di.Cli/CliHost.cs` | 配置 → AddDi() → 工具 / skills / runner / 会话；`--provider/--model/--thinking` 覆盖在此生效 |
| headless 单发 | `Di.Cli/modes/PrintMode.cs` | 文本流式渲染 / JSON 单文档；stdin 读提示词；skill 自动匹配（与 REPL 共享 `SkillActivation`）；错误 exit 1；会话日志（`--no-session` 关闭） |
| RPC 会话驱动后端 | `Di.Cli/modes/RpcMode.cs` | `--mode rpc`：NDJSON over stdin/stdout，ready 握手、事件流（text/reasoning/tool_call delta、工具生命周期、turn_completed、run_failed）、result/error；interrupt → `cancelled`；shutdown / EOF → 退出 0（协议唯一权威：docs/tui-rpc.md） |
| 全局命令分发 | `Di.Cli/Properties/PublishProfiles/di.pubxml` + `install.cmd` / `install.ps1` | win-x64 自包含单文件 di.exe → `~/.di/bin` → PATH 幂等；`install.*` 同时构建 TS TUI 并复制到 `~/.di/tui/`（node/npm 缺失只告警，不失败） |
| 模型切换 | `AgentRunner.CurrentModel`（`Core/AgentLoop/AgentRunner.cs`） | 运行中切换，按名经工厂解析 |
| 模型工厂 | `Di.Cli/DiServiceCollectionExtensions.cs` | `RetryingChatModel(ChatModelClient(llm, provider, name))` 组合 |
| UTF-8 输出 | `Di.Cli/Program.cs` | 显式 `Console.OutputEncoding=UTF8`：GBK 代码页下中文不乱码（管道 / 脚本安全） |
