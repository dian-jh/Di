# Core.Tools —— 八个内置编码工具

> 模块文档。回答"工具的统一形态是什么、schema 与执行器如何同源、工具集 / 共享会话 / 有界输出 /
> Windows 编码 / 超时强杀如何工作、使用说明怎么注入稳定前缀"。
> 上一级入口：`docs/README.md`；执行入口见 `docs/modules/agent-loop.md`。

## 目的与职责

Coding Agent 的**八个核心编码工具**（对应 pi 的 `https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/tools/index.ts` 约定）+ 注册表 + 执行器。
模型通过它们在工作区内完成任务：读 / 写 / 编辑文件、glob / grep 搜索、shell / powershell / python 执行。

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
- **shell 工具名随平台**（`CoreTools.PlatformShellName`）：`ToolNames.Bash = "bash"` 只是**内部注册键**，
  向模型展示的名字是 **Windows 为 `cmd`**（cmd.exe 命令提示符）、**其他平台为 `bash`**。
  描述 / `PromptSnippet` / `PromptGuidelines` 同样平台感知（Windows 上明确提示模型用
  `dir`/`type`/`findstr`/`echo %CD%`，避免发 `ls`/`tail`/`pwd` 得到"不是内部或外部命令"）；
  `CoreTools.Executor` 额外保留 `"bash"` 兼容别名（旧提示词 / 旧 skill 仍可调用，路由到同一实例）。
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
  每条命令按**原始字节**收集 stdout/stderr，结束时整段用 `ProcessEncoding.SmartDecode`（UTF-8 优先 /
  OEM 回退）解码；cmd 的回显行（以提示符标签开头）在**字节层**先剥掉，避免 GBK 回显与 .NET CLI 的
  UTF-8 输出混在同一段导致误判编码。退出码行（`_exitMarker:`）界定输出边界。
- `Core/Tools/ProcessRunner.cs`：统一进程执行，超时强杀（含进程树）、退出后独立的 1 秒管道排干预算、输出捕获（字节级有界累积，
  结束时整段解码，见 `BoundedByteBuffer`）。
- `Core/Tools/ProcessEncoding.cs`：子进程输出解码——`ChildOutput`（OEM 代码页，中文系统 = GBK）与
  `SmartDecode`（严格 UTF-8 优先、OEM 回退，处理接缝处被切断的多字节字符）；git / python 可传
  显式 `outputEncoding`（UTF-8）跳过智能判定。
- `Core/Tools/BoundedByteBuffer.cs`：**字节级**有界输出累积（头尾预算），任意长度输出内存恒定，
  超长截断头尾并插入提示；保留原始字节到解码前，支持解码前逐行预处理（如剥回显行）。
  （字符级版 `OutputBuffer.cs` 仍保留并被其单元测试覆盖。）
- `Core/Tools/ToolHelpers.cs`：JSON Schema 构造、参数解析、路径解析（相对路径以工作区为基准，允许绝对路径及 `..`）。

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
| grep | `Core/Tools/GrepTool.cs` | 正则内容搜索，`file:行号: 内容` 输出；limit/ignore_case/literal/context；超过 1 MiB 的文件跳过并**如实提示**（避免"跳过"伪装成"未找到匹配"）；扫描带墙钟预算与取消支持（见下"搜索边界"） |
| cmd / bash | `Core/Tools/BashTool.cs` | 平台默认 shell（Windows 为 `cmd`，其他平台为 `bash`）；独立进程或共享会话；默认 30s 超时强杀；保留 `bash` 兼容别名 |
| powershell | `Core/Tools/PowerShellTool.cs` | 独立 PowerShell 持久化会话（不能与 shell 工具共用） |
| python | `Core/Tools/PythonTool.cs` | `code` 必填，`working_dir` 可选；独立进程执行代码，默认 cwd 为系统临时目录；不提供操作系统沙盒或文件访问隔离；stdin 以 EOF 启动（见 `ProcessRunner.redirectInput`） |

## 搜索边界

`grep` / `glob` 都递归扫描目录树，为防把整个主目录（如 `C:\Users\<user>` 当工作区）这类超大范围当搜索起点而长时间卡死，二者共用两道防线：

- **扫描预算**（`GrepTool.DefaultScanBudgetSeconds` / `GlobTool.DefaultScanBudgetSeconds`，默认 60 秒）：超预算返回已找到的部分结果 + `[扫描超过 … 秒预算…]` 续查提示，并**不谎报"未找到匹配"**（截断 ≠ 无匹配，模型据此缩小 path/glob 范围重试）。可通过 `CoreTools.Options` 的 `Grep.ScanBudget` / `Glob.ScanBudget` 覆盖。
- **取消自检**：同步实现每文件轮询 `CancellationToken`，Ctrl+C / RPC `interrupt` 的取消信号能落地打断扫描（此前在途扫描不可打断，只能干等扫完）。

枚举（`ToolHelpers.EnumerateFiles`）除构建/依赖/版本控制目录（obj、bin、node_modules、.git 等）外，还按名跳过**缓存/配置宿主目录**：`AppData`、`Temp`、`cache`、`Caches`、`.cache`——它们是可再生目录，跳过不影响"搜代码"语义（2026-10-15 事故回归：grep 直扫 `C:\Users\52143` 含 AppData 卡死 10+ 分钟）。

## 当前 TypeScript 代码入口

| 文件（仓库根相对路径） | 职责 |
|---|---|
| `packages/coding-agent/src/core/tools/index.ts` | core tool registry and `createToolExecutor` |
| `packages/coding-agent/src/core/tools/read.ts`, `write.ts`, `edit.ts`, `glob.ts`, `grep.ts`, `bash.ts`, `powershell.ts`, `python.ts` | model schemas and tool implementations |
| `packages/coding-agent/src/core/tools/process-runner.ts` / `shell-session.ts` / `encoding.ts` / `output-buffer.ts` | process lifecycle, persistent shells, Windows decoding, bounded output |
| `packages/coding-agent/src/cli/cli-host-compose.ts` | production tool construction and host-owned shell lifetimes |
| `packages/coding-agent/test/tools/` / `packages/coding-agent/test/cli/bash-tool-rpc.test.ts` | tool and host/RPC integration tests |

下表是固定 C# 迁移基线位置，供行为差异核对。

## C# 基线代码入口（行为参考）

| 文件（相对仓库根） | 职责 |
|---|---|
| `Core/Tools/CoreTools.cs` | 注册表 / 工具集 / 组合工厂 / 使用说明 / `Executor` |
| `Core/Tools/ICoreTool.cs` | 工具统一形态（`Definition` / `PromptSnippet` / `PromptGuidelines` / `ExecuteAsync`） |
| `Core/Tools/*.cs`（每个工具一个文件） | 各工具定义与实现（见上表） |
| `Core/Tools/ShellSession.cs` / `Core/Tools/ProcessRunner.cs` / `Core/Tools/ProcessEncoding.cs` / `Core/Tools/OutputBuffer.cs` / `Core/Tools/ToolHelpers.cs` | 共享基础设施 |

## 关键符号

- `ICoreTool`、`CoreTools`（`ToolNames` / `PlatformShellName` / `AllToolNames` / `CodingToolNames` /
  `ReadOnlyToolNames` / `Definitions` / `CreateExecutor` / `CreateTools` / `CreateCodingTools` /
  `CreateReadOnlyTools` / `BuildInstructions` / `Options`（per-tool 嵌套配置类）/ `Executor`）
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
