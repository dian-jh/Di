# Core.Tools —— 八个内置编码工具

> 模块文档。回答"工具的统一形态是什么、schema 与执行器如何同源、工具集 / 共享会话 / 有界输出 /
> Windows 编码 / 超时强杀如何工作、使用说明怎么注入稳定前缀"。
> 上一级入口：`docs/README.md`；执行入口见 `docs/modules/agent-loop.md`。

## 目的与职责

Coding Agent 的**八个核心编码工具**（对应 pi 的 `https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/tools/index.ts` 约定）+ 注册表 + 执行器。
模型通过它们在工作区内完成任务：读 / 写 / 编辑文件、glob / grep 搜索、bash / powershell / python 执行。

## 实现原理

### 统一形态（`Core/Tools/ICoreTool.cs`）

每个工具 = 一个 `ChatTool` 定义（给模型的 JSON Schema：name / description / parameters）
+ 一个执行实现 `ExecuteAsync`：

- 参数是模型生成的**原始 JSON 字符串**；相对路径都以工作区为根。
- 参数缺失 / 文件不存在等可预期失败返回 `error:` 开头的**观察文本**（作为普通工具结果进入上下文，
  由模型下一轮自行纠正，不是崩溃）。
- `PromptSnippet`（一行"做什么"，对齐 pi 的 `promptSnippet`）与 `PromptGuidelines`
  （命令式操作规则，对齐 pi 的 `promptGuidelines`）由工具自身贡献，co-locate 在自己的定义文件里。

### 注册表与工具集（`Core/Tools/CoreTools.cs`）

- `ToolNames`：8 个工具名常量；`AllToolNames`（8 个）、`CodingToolNames`（read/write/edit/bash）、
  `ReadOnlyToolNames`（read/glob/grep）。
- **当前生产代码只用全量**（`Di.Cli/CliHost.cs` 调 `CoreTools.Definitions(workspace)`）；
  coding/read-only 是**预留的扩展缝，不是死代码，是组合能力**（镜像 pi 的
  `createAllToolDefinitions`，见 `https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/agent-session.ts` ——pi 自身
  同样只在 loop 里用全量，子集经 SDK 导出供外部消费者）。未来消费场景：只读 / 规划模式、
  **权限层降级**（用户拒绝写操作时切只读集，见 `docs/roadmap.md` Phase B）、headless/CI 安全模式、
  **上下文 token 预算**（小工具集 = 更小 schema = 更少 token）。
  powershell / python 只属于全量集（pi 的原始定义，忠实镜像）。
- **schema 与实现同源**：`Definitions()`（给模型的 `ChatTool` 列表）与 `CreateExecutor()`（运行时
  `IToolExecutor`）共用同一注册表（`CreateTools` + `CanonicalOrder`），定义与执行器**永不失配**；
  bash/powershell 的定义始终按共享持久化会话模式生成。
- **per-tool options**（`CoreTools.Options` 嵌套类）：统一在注册层配置各工具旋钮（超时 / 上限 / 路径）。

### 共享基础设施

- `Core/Tools/ShellSession.cs`：持久化 shell 会话——cwd / 环境变量 / 虚拟环境跨调用保持；惰性启动
  （不执行命令不拉起进程）；bash 与 powershell **各自独立会话**（语法 / 编码不同，不能共用）。
- `Core/Tools/ProcessRunner.cs`：统一进程执行，超时强杀（含进程树）、输出捕获。
- `Core/Tools/ProcessEncoding.cs`：Windows 输出编码——cmd 的 OEM 字节 vs git 的 UTF-8 字节分别解码；
  python 不依赖该假设（强制 UTF-8 两端对齐，见 `PythonTool`）。
- `Core/Tools/OutputBuffer.cs`：有界输出累积（头尾预算），任意长度输出内存恒定，超长截断头尾。
- `Core/Tools/ToolHelpers.cs`：JSON Schema 构造、参数解析、路径解析（防越界）。

### 使用说明注入稳定前缀（`CoreTools.BuildInstructions`）

`tools` 参数（请求体 `tools` 字段）是机器可读的**调用契约**；`BuildInstructions` 注入的是
schema 表达不了的**操作知识**（观察约定 / 行为偏好 / 协议），两者互补。写法对齐 pi 的 system prompt：
**每个工具一行 snippet + 命令式规则 bullet**；说明文本由工具自身贡献、动态聚合，与 schema 同源、
不再手写同步（人格"简洁 ReAct 助手、中文回答"由 `Di.Cli/CliHost.cs` 追加，不在此重复）。
输出作为第一条 system 消息落在字节稳定前缀里（可被配置 `AgentLoop:SystemPrompt` 整体覆盖）。
以共享持久化会话形态创建全量工具集（与 `CreateExecutor` 一致）、从实例聚合——工具集 / 顺序 / 说明
三者天然一致。清单一行一个工具（snippet），规则 = 全局 `GlobalPromptGuidelines` + 各工具
`PromptGuidelines` 去重聚合。

## 工具清单

| 工具 | 代码（相对仓库根） | 说明 |
|---|---|---|
| read_file | `Core/Tools/ReadFileTool.cs` | 行号前缀读取；start/end_line 行范围、1MiB 上限；超长截断并给"续读"协议 |
| write_file | `Core/Tools/WriteFileTool.cs` | 整体覆盖写入（非追加），自动建父目录 |
| edit_file | `Core/Tools/EditFileTool.cs` | old_string 唯一性校验的精准替换 |
| glob | `Core/Tools/GlobTool.cs` + `Core/Tools/GlobMatcher.cs` | 文件名模式搜索（`* ? **`）；匹配器独立可单测 |
| grep | `Core/Tools/GrepTool.cs` | 正则内容搜索，`file:行号: 内容` 输出；limit/ignore_case/literal/context |
| bash | `Core/Tools/BashTool.cs` | 一次性独立进程或共享持久化会话；超时强杀（默认 30s）；Windows 手工构造 `cmd /d /s /c` |
| powershell | `Core/Tools/PowerShellTool.cs` | 独立 PowerShell 持久化会话（不能与 bash 共用） |
| python | `Core/Tools/PythonTool.cs` | 沙盒临时目录执行代码（计算 / 数据处理 / 图表） |

## 代码入口

| 文件（相对仓库根） | 职责 |
|---|---|
| `Core/Tools/CoreTools.cs` | 注册表 / 工具集 / 组合工厂 / 使用说明 / `Executor` |
| `Core/Tools/ICoreTool.cs` | 工具统一形态（`Definition` / `PromptSnippet` / `PromptGuidelines` / `ExecuteAsync`） |
| `Core/Tools/*.cs`（每个工具一个文件） | 各工具定义与实现（见上表） |
| `Core/Tools/ShellSession.cs` / `Core/Tools/ProcessRunner.cs` / `Core/Tools/ProcessEncoding.cs` / `Core/Tools/OutputBuffer.cs` / `Core/Tools/ToolHelpers.cs` | 共享基础设施 |

## 关键符号

- `ICoreTool`、`CoreTools`（`ToolNames` / `AllToolNames` / `CodingToolNames` / `ReadOnlyToolNames` /
  `Definitions` / `CreateExecutor` / `CreateTools` / `CreateCodingTools` / `CreateReadOnlyTools` /
  `BuildInstructions` / `Options`（per-tool 嵌套配置类）/ `Executor`）
- `ShellSession`、`ProcessRunner`、`OutputBuffer`、`ProcessEncoding`、`ToolHelpers`
- `CoreTools.Executor`（`IToolExecutor` 实现，按工具名分发，未知名返回错误观察）

## 流动路径（声明到执行）

```
Di.Cli/CliHost.cs
  ├─ CoreTools.Definitions(workspace)         ← 生成 8 个工具 schema
  └─ CoreTools.CreateExecutor(workspace)      ← 生成运行时执行器（含 bash/powershell 持久化会话）
        ↓
Core/AgentLoop/AgentRunner.cs                  ← 构造：_tools 塞进 AgentRequest.Tools
        ↓
Core/AgentLoop/ReAct.cs                        ← 每次迭代带上完整 tools（内层循环）
        ↓
Core/Llm/ChatModelClient.cs                    ← ModelRequest.Tools → GenerateOptions.Tools
        ↓
Core/Providers/DeepSeek/DeepSeekTranslator.cs  ← ToWireTool 序列化请求体 tools
```

执行侧：ReAct 只认 `IToolExecutor`（`Core/AgentLoop/IToolExecutor.cs`），由 `AgentRunner` 注入
`CoreTools.Executor`；ReAct 不识别具体工具。

## 已实现能力与测试

| 能力 | 落点 | 测试 |
|---|---|---|
| 8 个内置编码工具 | `Core/Tools/CoreTools.cs` | `Di.Tests/Tools/*ToolTests.cs` |
| 注册表与工具集（all / coding / read-only） | `CoreTools.CreateTools` | `Di.Tests/Tools/CoreToolsTests.cs` |
| 共享持久化 shell 会话 | `ShellSession` / `BashTool` / `PowerShellTool` | `Di.Tests/Tools/ShellSessionTests.cs` 等 |
| 有界输出（内存恒定） | `OutputBuffer` | `Di.Tests/Tools/OutputBufferTests.cs` |
| 超时强杀 + 会话自动重建 | `ProcessRunner` / `ShellSession` | `Di.Tests/Tools/ShellSessionTests.cs` 等 |
| Windows 编码处理（OEM vs UTF-8） | `ProcessEncoding` | `Di.Tests/Tools/EncodingTests.cs` |
| 精准编辑（old_string 唯一性） | `EditFileTool` | `Di.Tests/Tools/EditFileToolTests.cs` |
| schema 与实现同源 | `CoreTools.Definitions` / `CreateExecutor` | `Di.Tests/Tools/CoreToolsTests.cs` |
| 使用说明由工具自身贡献聚合注入稳定前缀 | `CoreTools.BuildInstructions` | `Di.Tests/Tools/CoreToolsTests.cs` |

## 关联文档

- `docs/modules/agent-loop.md` —— 工具的执行入口（`IToolExecutor`）与失败=观察约定
- `docs/cli.md` —— 工具在组合根的装配（`CliHost`）
- `docs/architecture.md` —— 关键设计决策 #10（schema 与说明互补、同源、子集预留）
