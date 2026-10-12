# CLI 层契约：harness 与会话驱动的边界

> 设计文档。回答"CLI 层为什么这么分层、哪部分可以换语言重写、重写时保留什么"。
> 核心主张：**会话驱动 API 在 harness 层（`Core.AgentLoop`），CLI 只是"参数 + 模式 + 渲染"的薄壳**。
> 参考实现：Pi 的 `main.ts → resolveAppMode → 模式执行器` 结构
> （外部参考：兄弟仓库 `https://github.com/earendil-works/pi/tree/main/packages/coding-agent`）。
>
> 配套文档：`docs/README.md`（总索引）、`docs/architecture.md`（架构与关键决策）、
> `docs/roadmap.md`（能力全景与路线图）。

---

## 1. 分层一句话

| 层 | 位置 | 职责 | 换语言时 |
|---|---|---|---|
| **harness 契约**（稳定，复用） | `Core.AgentLoop`、`Core.Llm`、`Core.Tools`、`Common.Events` | 驱动一个回合、事件流、结果、工具、模型 | **保留**（用新语言绑定/调用） |
| **CLI 薄壳**（可重写） | `Di.Cli` | 参数解析、模式选择、组合根、渲染、进程退出码 | **整体重写**，按本文档契约对齐 |

任何语言的 CLI 都只做三件事：**解析参数 → 决定模式 → 用同一个会话 API 跑并渲染**。
参数与模式的解析是纯函数（无 I/O），因此规则可以（也应该）在另一种语言里原样复刻。

---

## 2. harness 侧稳定契约（换语言时"调用"它）

这是 CLI 唯一依赖的运行时面。三种语言的 CLI 都要通过它们驱动同一个会话。

### 2.1 会话驱动 —— `IAgentRunner`（`Core/AgentLoop/IAgentRunner.cs`）

```csharp
public interface IAgentRunner
{
    string CurrentModel { get; set; }              // /model 切换、-m 覆盖
    IReadOnlyList<Skill> ActiveSkills { get; set; } // 固定 + 自动匹配，可叠加
    Task<AgentResult> RunAsync(string userMessage, CancellationToken ct = default);
    void ResetHistory();                            // /clear：清空跨回合记忆
}
```

一次 `RunAsync` = 一个完整回合：环境快照进历史 → ReAct 循环 → 事件经总线发布 → 返回结果。
CLI 不感知 ReAct 内部，只消费事件流与最终结果。

### 2.2 事件流 —— `AgentLoopEvent`（`Common/Events` + `Core/AgentLoop/AgentLoopEvent.cs`）

运行中的事件经 `IEventBus`（`Common.Events`）发布，UI 从同一总线消费。事件是**拉式**（channel）或**推式**（订阅）均可；headless 文本模式用拉式流式渲染，json 模式根本不消费。

> 事件类型 / 负载 / 含义的**唯一权威表**见 `docs/modules/events.md` §关键符号，此处不复述。
> 换语言契约视角：CLI 依赖的事件流只有「流式文本增量」「工具生命周期」「回合结束（用量 / 成本 /
> 停止原因）」「循环失败」四类，字段细节以 `docs/modules/events.md` 为准。

### 2.3 结果 —— `AgentResult`（`Core/AgentLoop/AgentResult.cs`）

```csharp
class AgentResult
{
    string Answer;                              // 最终可见文本
    IReadOnlyList<ChatMessage> Trajectory;      // 完整轨迹（可重放）
    TokenUsage Usage;                           // 累计 tokens
    UsageCost? Cost;                            // 累计成本（无费率时 null）
    int Iterations;                             // 实际轮数
    AgentStopReason StopReason;                 // Answer / FinalOutputTool / MaxIterations / Error
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
  → 短路径（Version/Help）直接输出退出，不建 DI
  → CliHost.Create(...)               组合根：配置 → AddDi → 工具/skills/runner/会话日志
  → 分派：Interactive → Repl；Print/Json → PrintMode；ListModels → 列目录；Rpc → 未实现
```

### 3.2 纯数据与纯函数（语言无关，建议他语言原样复刻）

- **`CliArgs`**（`Di.Cli/cli/CliArgs.cs`）：`Positionals`、`Model`、`Provider`、`Print`、`Mode`、
  `Version`、`Help`、`ListModels`、`Thinking`、`NoSession`、`NoAnsi`、`UnknownFlags`。
  规则：`--` 后全为位置参数；带值旗标缺值报错；`--list-models [pattern]` 可选吃下一个非旗标 token；
  `--mode` 值域 `interactive/print/json/rpc`；未知旗标记入 `UnknownFlags` 并报错（不静默忽略）。
- **`CliMode.Resolve(CliArgs, stdinTty, stdoutTty)`**（`Di.Cli/cli/CliMode.cs`）：

| 条件 | 模式 |
|---|---|
| `--version` / `--help` | 对应短路径（优先，直接输出退出，不建 DI） |
| `--list-models` | ListModels（仍建宿主，列出模型目录） |
| `--mode json` | Json |
| `--mode print` | Print |
| `--mode interactive` | Interactive |
| `--mode rpc` | Rpc（本实现未支持 → exit 1） |
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
- 退出码：`0` = 成功；`1` = 用法错误 / 运行错误（模型不可用等）。脚本以退出码判成败。

---

## 4. Headless 契约（脚本 / CI 依赖它）

### 4.1 文本模式（默认 / `--mode print`）

事件流式渲染到 stdout（无 ANSI、无"正在请求"状态行），结果脚注；`--no-ansi` 进一步禁控制序列。
会话日志写入 `~/.di/sessions/`（`--no-session` 关闭）。

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
| 会话驱动（harness） | `Di.Tests/AgentLoop/AgentRunnerTests.cs` | 模型路由、历史裁剪、快照、skills |

## 7. 实现现状（Di.Cli 落点）

> 各能力的"能力 → 落点 → 测试"完整对应见模块文档 `docs/modules/agent-loop.md`（循环侧）与
> `docs/modules/events.md`（事件侧）。下表是 Di.Cli 自身的实现落点（相对仓库根）。

| 能力 | 代码（相对仓库根） | 说明 |
|---|---|---|
| REPL 外层循环 | `Di.Cli/Repl.cs` | 读行 → 斜杠命令 → 回合；回合事件实时渲染 + 兜底排空 |
| 流式渲染 | `Di.Cli/EventRenderer.cs` | 逐字输出；工具调用 / 思考轮 / 用量+成本脚注；ANSI 状态行（重定向自动禁用） |
| 斜杠命令 | `Di.Cli/Repl.cs`（`RunCommand`） | `/help` `/clear` `/model` `/skills` `/skill` `/exit` |
| 纯参数解析（语言无关契约） | `Di.Cli/cli/CliArgs.cs` | `string[] → CliArgs` 纯数据 + 诊断；`--` 截断、未知 / 缺值 / 非法模式报错 |
| 纯模式解析 | `Di.Cli/cli/CliMode.cs` | `Resolve(args, stdinTty, stdoutTty)`；短路径优先（version/help 直接输出不建 DI；list-models 仍建宿主） |
| 分派壳 | `Di.Cli/CliApp.cs` | 解析 → 校验 → 模式 → 建宿主 → 分派；不碰 Console（流与 TTY 由调用方注入） |
| 组合根 | `Di.Cli/CliHost.cs` | 配置 → AddDi() → 工具 / skills / runner / 会话；`--provider/--model/--thinking` 覆盖在此生效 |
| headless 单发 | `Di.Cli/modes/PrintMode.cs` | 文本流式渲染 / JSON 单文档；stdin 读提示词；错误 exit 1；会话日志（`--no-session` 关闭） |
| 全局命令分发 | `Di.Cli/Properties/PublishProfiles/di.pubxml` + `install.cmd` / `install.ps1` | win-x64 自包含单文件 di.exe → `~/.di/bin` → PATH 幂等 |
| 模型切换 | `AgentRunner.CurrentModel`（`Core/AgentLoop/AgentRunner.cs`） | 运行中切换，按名经工厂解析 |
| 模型工厂 | `Di.Cli/DiServiceCollectionExtensions.cs` | `RetryingChatModel(ChatModelClient(llm, provider, name))` 组合 |
| UTF-8 输出 | `Di.Cli/Program.cs` | 显式 `Console.OutputEncoding=UTF8`：GBK 代码页下中文不乱码（管道 / 脚本安全） |
