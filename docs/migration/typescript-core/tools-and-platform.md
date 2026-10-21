# TypeScript Core 迁移：工具与平台执行

> 状态：迁移实施指南。八工具组件已实现于 `packages/coding-agent/src/core/tools/`。
> `packages/coding-agent/src/cli/cli-host-compose.ts` 的 `createCliHost` 为 cmd/POSIX 与
> PowerShell 各持有独立的惰性 `ShellSession`，随 host 释放；`createBashTool` /
> `createPowerShellTool` 接受 `session`，未注入时保留 one-shot 模式。Python 保持独立进程。
> 契约表以 C# 基线为准，当前验证证据与未通过门槛见 [`progress.md`](progress.md)。
> 基线 Di：`09f4e0816c1b2dc42461e79a968b46e811d3880c`；Pi 只读参考：
> `7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333`。共享包边界见
> [`architecture.md`](architecture.md)。模型中的 `ToolSpec` / `ProviderChunk` / `ModelEvent` 和 loop 的
> `ToolExecutor.execute(call, signal)` 由 architecture 文档唯一规定；本文只定义 Di 工具语义。
> loop 与历史边界见 [`loop-and-state.md`](loop-and-state.md)，会话兼容见
> [`sessions-and-compatibility.md`](sessions-and-compatibility.md)；TUI RPC 契约仍由
> [`docs/tui-rpc.md`](../../tui-rpc.md) 唯一维护。

## 范围、路径与运行时约束

行为参考：`Core/Tools/`（`CoreTools`, `ICoreTool`、8 个工具、shell/process/encoding helpers），
测试 `Di.Tests/Tools/`。当前 Node 宿主实现位于 `packages/coding-agent/src/core/tools/`；纯
`packages/agent/` 只依赖工具执行抽象，不引入 Node API。现有 TUI 保留在 `tui/` 与
`tui/src/app/`，首期由兼容既有 `--mode rpc` 的 TS backend 承接，后续才可选本地 Runner
接线。不得把路径写成 `E:\Agent\Di` 的机器绑定路径。

目标 Node `>=22.19`，ESM、strict TypeScript、`noUncheckedIndexedAccess` 和 erasable TS。沿用现有
`tui/package-lock.json` 实际锁定的 TypeScript `5.9.3`、`@types/node` `22.20.5`、`pi-tui` `1.2.0`；
本机 Node `24.16.0`。不要照抄 Pi TS7。新增依赖先核对真实版本、API、license、Node 要求、Windows
行为和依赖树，再固定 lockfile。首期优先 Node 内置 `node:fs/promises`、`node:child_process`、
`node:stream`、`node:crypto`，不得将 whole Pi 当 runtime。

## 8 个工具契约

下表按当前 C# schema 概括。字段名、必填、默认值和输出边界迁移后保持一致；具体 JSON schema
仍以当前工具定义为准。所有相对路径从工作区根解析，但已有实现允许显式绝对路径及 `..`，不要
擅自增加 sandbox 路径拒绝规则。可预期错误返回以 `error:` 开头的观察文本，loop 将其作为 tool
result 回填，不把它升级为进程级异常。

| 名称（Windows 平台展示） | 参数 | 当前行为/观察边界 | 当前 C# 入口 |
|---|---|---|---|
| `read_file` | 必填 `path`; 可选 `start_line`（1-based）、`end_line`（inclusive） | UTF-8 文本按行编号；文件默认最大 1 MiB，输出最多 2000 行/约 64 Ki UTF-16 code units；输出截断明确提示 `start_line=N` 续读；超大文件报错，单行超过展示预算给出替代建议 | `Core/Tools/ReadFileTool.cs` |
| `write_file` | 必填 `path`, `content` | 覆盖整个文件，不是 append；自动建父目录；结果/错误为观察文本 | `Core/Tools/WriteFileTool.cs` |
| `edit_file` | 必填 `path`, `old_string`, `new_string` | 仅当 old_string 非空且恰好出现一次时替换；0 次/多次都返回 error；匹配时统一 LF，写回恢复原文件检测到的 CRLF/LF 风格，并保留 UTF-8 BOM | `Core/Tools/EditFileTool.cs` |
| `glob` | 必填 `pattern`; 可选 `path`, `limit`（默认 200） | `*` 单目录、`?` 单字符、`**` 跨目录；Windows 匹配不区分大小写；默认跳过生成/依赖/VCS 与缓存目录；最多 200 结果；预算/上限返回部分结果及“尚未穷尽”提示 | `Core/Tools/GlobTool.cs`, `GlobMatcher.cs` |
| `grep` | 必填 `pattern`; 可选 `path`, `glob`, `ignore_case`, `literal`, `context`, `limit`（默认 100） | 默认 .NET 正则；literal 时转普通文本；输出 `file:line: text`；行长最多 500 字符；单文件最多 1 MiB，超大文件跳过并明示；匹配上限/扫描超时返回部分结果及提示 | `Core/Tools/GrepTool.cs` |
| `cmd`（内部别名 `bash`） | 必填 `command`; 可选 `timeout`（默认 30s，上限 3600s）；one-shot 模式另有 `working_dir` | Windows 使用 cmd.exe，其他平台 bash；模型展示 Windows `cmd`，保留旧 `bash` 路由别名；生产配置为持久 shell，one-shot 可指定 cwd；输出统一 `exit: N` / `error: ...`，截断保留头尾 | `Core/Tools/BashTool.cs` |
| `powershell` | 必填 `command`; 可选 `timeout`（默认 30s，上限 3600s）；one-shot 模式可选 `working_dir` | 独立 PowerShell 会话（不与 cmd/bash 共用）；生产为持久会话，cd/变量/环境跨调用；超时杀会话、下次自动重建 | `Core/Tools/PowerShellTool.cs` |
| `python` | 必填 `code`; 可选 `working_dir` | 通过 `python -c` 执行；默认 cwd 为系统临时目录；stdin 立即 EOF；输出强制 UTF-8；默认 30s；**不是 OS sandbox**，不声称限制文件/网络访问 | `Core/Tools/PythonTool.cs` |

生产组合根由 `Core/Tools/CoreTools.cs` 统一生成 schema 和 executor，canonical 顺序为 read/write/edit/
glob/grep/shell/powershell/python。all/coding/read-only 集合与名称别名是组合能力；当前生产端使用
全量工具。工具说明由每个 `ICoreTool` 的 PromptSnippet/PromptGuidelines 与全局规则聚合，说明与 schema
同源。迁移需保留该共置方式，不能另写一套容易漂移的 prompt 文本。完整现状说明及测试映射见
[`docs/modules/tools.md`](../../modules/tools.md)。

## .NET 与 JavaScript 搜索语义差异

不得把 .NET `Regex`/glob 直接替换为 JS 默认实现并声称等价：

- .NET regex 默认是非 ECMAScript 语法、Unicode/文化不变选项组合；JS `RegExp` 是 ECMAScript。下表
  是实施时必须完成的 conformance matrix；状态是迁移 gate，不预判兼容：

| 语法/行为 | Di `.NET Regex` 现状 | TS 首期 gate |
|---|---|---|
| 字面量、`.`、字符类/范围、`^`/`$`、常用量词 | 支持 | 逐项跑跨平台 fixture，确认换行与 Unicode 行为后可标兼容 |
| 捕获/非捕获组、alternation、贪婪/懒惰量词 | 支持 | 比较命中位置与重复/空匹配行为；未验证为阻断 |
| `\w`、`\b`、大小写忽略 | `RegexOptions.CultureInvariant`，可选 `IgnoreCase` | .NET 与 JS Unicode/文化折叠不同；需固定 Unicode fixture，未通过明确标不兼容 |
| lookahead/lookbehind、named group、反向引用 | .NET 支持其自身语法版本 | Node 当前语法/命名引用差异逐项确认；不支持项是 blocker，禁止静默降级 |
| 多行/单行选项、孤立 CR/LF、非法语法错误 | 由 .NET 默认及当前 options 决定 | 对应 JS flags/解析错误不保证同义；显式验证后才可兼容 |
| 灾难回溯与超时 | C# 当前 Regex 没有在此工具内配置统一超时 | JS 正则同步且不可中断；worker 超时 terminate 是 TS 新安全边界，作为行为改进记录 |

预计共同子集仅作初始实现候选。迁移只有在固定 corpus 中所有现有使用语法都有明确结果、并对无法
支持的 .NET 表达式给出兼容决定后才可验收；不能因部分 corpus 通过就宣称兼容。
- JS `RegExp` 是同步执行，扫描预算与 AbortSignal 无法中断灾难回溯。若采用 JS regex，必须把每个有界
  regex job 放到 `worker_threads`，超时后 `worker.terminate()` 并替换 worker；不得只用 `Date.now()` 在
  regex 前后检查。若采用 RE2 风格依赖，需核实其不支持特性并使用相同兼容矩阵。不能无限制运行
  未知表达式，也不能静默改正则语义。
- glob 的 `**` 语义必须独立定义：匹配路径分隔符、`*` 不跨目录、`?` 单字符、Windows 大小写规则，
  目录分隔符归一为 `/`。常见 npm glob package 对 `**/`、隐藏文件、`{}`、`[]`、绝对 pattern 有
  自己的扩展；不要把扩展泄漏进 Di 契约。继续保留独立 matcher，回归 C# fixture。
- `path.relative`/`path.resolve` 返回平台分隔符；工具输出统一 `/`，匹配 Windows 路径时大小写策略
  明确，避免 locale-sensitive 比较。不要让忽略目录规则依赖某个平台特定路径大小写。
- JS 字符串长度按 UTF-16 code unit，C# string 也以 UTF-16 code unit 为单位；Buffer 长度是 UTF-8
  字节。现有搜索长行/文件阈值须确认单位并单独实现，不可把“500 字符”静默改成 500 bytes。

## 文件 IO 与 TUI 事件循环

所有工具文件读写、目录枚举、grep/glob、凭据/session 写入都用 async fs API 或 `node:stream`；禁止
`readFileSync`/`writeFileSync`/同步目录递归出现在 TUI 主线程、RPC reader 或事件渲染路径。即便单个
小文件很快，同步 IO 也会阻断 delta 渲染与 interrupt。同步 helper 只允许极小、纯内存、无 IO 的
初始化逻辑。

- `read_file`、`write_file`、`edit_file` 每个 await 边界检查 AbortSignal。现有 C# `edit_file` 用
  `File.WriteAllText` 原位写入；迁移目标可提升为同目录临时文件 + flush + rename 原子替换（这是**新增
  改进**，不是现状复刻），但需在 Windows/Unix 验证文件 ACL/权限、只读属性、时间戳、硬链接语义与
  rename 覆盖规则；失败时保留原文件并清临时文件。Node 无法把多个文件操作变成原子事务。
- `glob`/`grep` 使用异步目录迭代器逐项扫描，扫描预算默认 60 秒、响应 AbortSignal；返回上限/预算
  时必须说结果为部分集，不能伪报“无匹配”。目录跳过规则至少保留 `.git`、`bin`、`obj`、
  `node_modules`、`AppData`、`Temp`、`cache`/`Caches`/`.cache` 等当前 `ToolHelpers` 规则。
- UTF-8 文本读取：明确 BOM 处理和非法字节策略。read/edit 保持现有 BOM 去留规则；write 使用 UTF-8
  且与当前 serializer 约定一致。不要用操作系统默认编码。
- 所有工具的 stderr/stdout/partial output 都有界；错误信息不能包含大段凭据或无限子进程输出。

## 子进程：one-shot 超时、取消、输出和树终止

`child_process` 只提供进程创建能力，不能替代现有 `ProcessRunner` 与 `ShellSession` 的行为。独立的异步
runner 已在 `packages/coding-agent/src/core/tools/process-runner.ts` 实现（P4.4，`runProcess`/
`ProcessResult`；P4.5 经其 `shell: true` 模式接入一次性 cmd/bash 工具），下述为已实现契约：

Di 当前 `ProcessRunner.Kill(Process)` 与 `ShellSession.Kill()` 调用 `.NET Process.Kill(entireProcessTree:true)`；
超时路径先终止进程树再回传 partial output。Node 的 `ChildProcess.kill()` 只表示发信号给该子进程，不能
当作此现状的等价 API。

1. 用 `spawn(file, args, {cwd, env, stdio, shell:false, windowsHide:true})`；只有明确执行 cmd
   命令的边界才按 cmd 规则组装 command line。其他命令优先参数数组，避免引入 shell quoting 注入。
2. stdout、stderr 并行 drain，采用 Buffer 字节 ring（头 6000、尾 18000 bytes）而不是无限拼接字符串；
   超限在解码后插入“中间已截断 N 字节”标识。不能只在命令结束后才截字符串，否则巨量输出先占满内存。
3. 启动一个 AbortSignal 与 timeout 的统一生命周期；外部取消传出 AbortError/取消语义，工具超时返回
   `error:` + 有界 partial output。两者都触发进程树终止、管道关闭、drain 排干和资源回收；失败启动
   也回成观察文本。
4. Windows `child.kill()` 仅杀直接子进程，Windows `detached:true` 不提供 POSIX process group 信号语义。
   首期明确 `spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {windowsHide:true})` 并等待原进程退出，
   检查 taskkill exit status；或实现经过验证的 Job Object 小适配层。不把 detached 组信号写成 Windows
   方案。POSIX 才以 `detached:true` 创建新 process group，并用 `process.kill(-pid, 'SIGTERM')`、短暂
   宽限后 `process.kill(-pid, 'SIGKILL')` 终止整组。实现记录 PID、区分已退出 race，并确认没有孙进程
   遗留；两种平台分别集成验收。
5. 进程退出后给 stdout/stderr drain 独立约 1 秒排干预算；有子孙继承 pipe 时截止并关闭读端，避免
   工具永久挂起。输出包含 `exit: N`，shell 调用失败包含 `error:`；非零退出码仍是观察文本而非 throw。
6. 每次调用清理 listeners/timers/streams，防止长会话 EventEmitter listener 累积。tool loop 串行调用
   当前工具 executor；单进程生命周期和所有 await 都接受 signal。

## Windows OEM/GBK 与 UTF-8 输出

当前 `Core/Tools/ProcessEncoding.cs` 不依赖 console encoding：中文 Windows OEM 通常 GBK/936，cmd
内建命令（如 `dir`）可能输出 OEM bytes，而重定向的 .NET CLI 输出 UTF-8；同一 pipe 里编码源可不同。
`chcp 65001` 不保证改变重定向 pipe 字节。Python 通过 `PYTHONIOENCODING=utf-8` 并显式 UTF-8 解码。

当前 schema 描述中的“64KB”与具体 `ReadFileTool.Number` 实现的计数单位有差异：实现按 .NET
`string.Length`（UTF-16 code units）计数。迁移 fixture 应以实际 C# 行边界结果为基线，同时可在
文档/schema 中称“约 64K 字符”；若日后改为 UTF-8 bytes，作为独立可见行为变更处理。

Node 替代必须按字节收集，不能直接让 `spawn({encoding:'utf8'})` 流式解码：非 UTF-8 GBK 会出现替换
字符，且 UTF-8 多字节码点跨 chunk 时也要由 `StringDecoder('utf8')` 或完整 buffer decoder 保持。
建议规则：

- Python/git 等已显式约定 UTF-8 的命令，强制 UTF-8 环境并以 UTF-8 解码。
- Windows cmd 混合输出：先剥离 shell command echo 和 Di marker 的原始 ASCII/字节行，再尝试整个
  输出的严格 UTF-8；非法时取系统 OEM code page 并检测该编码 decoder 是否可用。Node 的 ICU
  `TextDecoder` 在本机可通过 `new TextDecoder('gbk').decode([0xd6, 0xd0])` 正确解为“中”，但此能力
  依赖 ICU/build，且不代表每种 OEM code page 都受支持。实现启动时用 `TextDecoder` capability probe；
  OEM code page 的发现仍需 Windows API 小适配层（例如 `GetOEMCP`），不可把 GBK 写死为所有 Windows
  的默认。缺少对应 decoder 时不得乱码替代或谎称兼容，应明确返回解码错误/可诊断 fallback。
- 依赖决策可评估 `iconv-lite` 等 decoder 的锁定版本、license 与维护性；也可为非 ICU 编码增加小型
  原生适配层。必须覆盖系统 OEM 936 与至少一个非 GBK OEM code page 的能力探测/失败路径。
- 对被头尾截断的 buffer，头段尾/尾段头可能切断 UTF-8 code point；严格 UTF-8 探测最多裁掉边界
  1–3 bytes 再判定，确实是 OEM 才 fallback。只允许接缝损失不超过一个字符，不能将全段 UTF-8
  中文误判 GBK。
- PowerShell stdin 以无 BOM UTF-8 送入；Windows PowerShell 5.1 对开头 BOM 行为与现代 pwsh 不同。
  需分别运行实际平台验收，不能只 mock `process.platform`。

cmd stdin 由 `packages/coding-agent/src/core/tools/encoding.ts` 的 `createLegacyEncoder` 按
`discoverOemCodePage` 返回值编码；`packages/coding-agent/src/core/tools/shell-session.ts` 的
`ShellSession.execute` 在代码页不可用时返回错误，不写入命令。PowerShell/POSIX 仍使用无 BOM
UTF-8，不修改全局 console code page。编码器采用精确锁定的 `iconv-lite@0.7.3`（MIT，声明
Node `>=0.10.0`；公开 API `encodingExists` / `encode`，见 [上游说明](https://github.com/pillarjs/iconv-lite/blob/master/README.md)），
传递依赖 `safer-buffer@2.1.2` 锁在根 lockfile；`install.ps1` 同时分发二者。接入前隔离探针验证
936→GBK、437→OEM 字节及未知页拒绝；实际 Windows 中文目录往返与 helper 测试见
`packages/coding-agent/test/tools/shell-session-encoding.test.ts`。最低 Node 与其他平台仍需发布验收。

验收样例必须同时有中文 `dir` 文件名、UTF-8 `dotnet`/Node 输出、Python UTF-8、混合 stdout/stderr、
截断点正好落在中文字符中间的输出。

## 持久 shell 会话协议

生产工具共享长驻 shell：cwd、环境变量、虚拟环境状态需跨调用保留。cmd/bash 与 PowerShell 是两个
独立会话，不能混用。Node 实现为 `packages/coding-agent/src/core/tools/shell-session.ts` 的 `ShellSession`：

- lazy spawn，首次执行才创建进程；用 async iterator/line buffer 读取 stdout，stderr 另行后台 drain。
- 每条命令后附加随机不可预测 marker 和退出码 marker，唯有完整匹配当前会话 nonce 的 marker 才结束
  本次调用。marker 可以与“不带换行”的用户输出粘在同一行，解析器必须识别行尾 marker 并保留前置
  字节；不要依靠固定 prompt 或等待安静间隔。
- cmd 每条输入会回显；初始化唯一 prompt tag，按原始字节剥掉仅以 tag 开头的 echo 行，再解码。
  PowerShell 单独使用 `-Command -` 与无 BOM UTF-8 stdin；POSIX shell 使用单独 argv/启动参数。
- 同一 session 使用 async mutex 串行 command；命令超时或外部取消杀整个会话树，保留 partial output，
  下一次调用自动惰性重建；用户命令自己执行 `exit` 也触发重建。跨调用 cwd/env 应仅在进程仍活时保留。
- 每次命令的 stderr 与 stdout 收集到各自有界 Buffer。读到 exit marker 后取消 stderr drain 并等待其
  排干；退出后再给剩余 pipe 独立排干预算，防止子进程持有管道。
- marker 行不能被误认为 shell 命令输出，也不能因用户输出恰好含静态 marker 而提前收尾；必须使用每次
  会话随机 marker、每条命令递增 nonce，并对带 marker 文本、无换行输出、并发请求、cmd echo 做测试。

## Pi pinned 源码参考与复用判断

Pi 是协议形态参考，Di 当前工具契约仍由 C# 代码/文档决定。参考固定到提交
`7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333`：

- [`tools/index.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/src/core/tools/index.ts)：工具集工厂。
- [`read.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/src/core/tools/read.ts)、[`write.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/src/core/tools/write.ts)、[`edit.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/src/core/tools/edit.ts)
- [`grep.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/src/core/tools/grep.ts)、[`find.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/src/core/tools/find.ts)、[`bash.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/src/core/tools/bash.ts)、[`powershell.ts`](https://github.com/earendil-works/pi/blob/7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333/packages/coding-agent/src/core/tools/powershell.ts)

在复用 Pi 实现前，核对该提交目录实际 API、依赖许可（MIT）、平台实现与 Di 差异；只提取小型可理解
算法并在 Di tests 下重新验证。不得使用 E 盘路径，不得以 whole Pi package/runtime 代替 Di 包边界。
Pi 没有 Di 当前 Python/cmd 语义等价物，不能用 Pi 全量工具覆盖这些功能。

## 最小实施顺序与停止条件

按单元逐个完成测试与实现；每条“停止”都表示不要跳过、mock 成绿或继续接入宿主：

1. **registry/schema**：先写 8 工具 schema 和注册顺序 fixture，再实现 definitions/executor 共用注册表。
   停止：平台 shell 名、必填字段、默认值或 schema/executor 集合不一致时，不进入工具实现。
2. **异步文件工具**：依次 read、write、edit；edit 测 CRLF、LF、孤立 CR、UTF-8 BOM，原子写若实现必须另
   作为改进 case 测 ACL/attributes。停止：路径解析或观察文本变化未说明、取消后文件可能半写、权限/只读
   属性语义未决时，不接入 loop。
3. **glob 与 grep**：先冻结 .NET→TS regex matrix 和 glob fixture，逐语法批准兼容范围；regex worker 做
   可终止 job。停止：Di 既有表达式的结果仍未知、超时不能 terminate worker、或被忽略目录被报成“无匹配”时，
   搜索阶段不得标绿。没有等价的未支持语法必须列为显式迁移 blocker，不能静默返回空结果。
4. **ProcessRunner**：先做 POSIX runner，再做 Windows tree-kill adapter；选择 Windows taskkill 或 Job Object
   后记录真实实现和系统版本。停止：任一孙进程存活、taskkill 失败后只杀父进程、pipe drain 无界等待，均为
   blocker；不能把 `child.kill()` 单独算通过。
5. **编码适配**：先探测 ICU `TextDecoder` 编码支持，再实现 OEM code page discovery adapter；在 936 与一个
   非 GBK OEM 上验收。停止：系统 code page 无法取得或 decoder 不支持时，返回显式解码错误并保留有界 raw
   bytes 供诊断；禁止静默以 UTF-8 替换字符输出并宣称兼容。
6. **ShellSession**：单独实现随机 nonce、marker parser、stdin encoding、stdout/stderr drain、会话 mutex 和
   kill/recreate。停止：无换行输出粘 marker、命令输出包含伪 marker、并发命令、超时后 cwd/env 状态任一不符，
   不接到 ReAct。
7. **host/RPC**：最后接进 `coding-agent/src/core/tools/`，沿既有 RPC 传同形观察字符串。停止：RPC event loop
   被工具 IO/regex/目录扫描阻塞，或旧 TUI 的工具状态/错误显示变形，不切本地 Runner。

### 平台能力与未决依赖门

本规划尚未锁定 Windows ACL、跨平台 advisory lock、系统 OEM code page discovery 或 regex engine 的新增
依赖/native binding。执行代理必须先提交一页决策记录：候选准确版本、MIT/兼容许可、Node `>=22.19`/ESM
支持、Windows 构建可用性、Unix/Windows 能力对应、维护/安装失败策略。确认前不允许通过临时 shell 命令、
未锁定包或“CI 此机恰好可用”写入正式实现。若原生 binding 未能在支持平台安装，必须停止对应能力，不得
降级成直接子进程 kill、UTF-8 猜测、JS event loop 同步 regex、或无锁凭据写入。

Windows process tree 的默认可实现基线是以 argv 调 `taskkill /PID pid /T /F` 并等待整树退出；如果部署
策略不允许 taskkill 或验证失败，则 Job Object 需作为显式 native API 决策，不得悄悄回退 `child.kill()`。
OEM fallback 同理：`TextDecoder` 只证明某个编码别名当前可解码，不负责取得 Windows 系统 OEM id；两步均
通过真实 Windows 集成测试才算就绪。

## 红测试清单与实施顺序

每项先在 `node:test` 写红测，再实现。建议顺序：

1. Schema fixture 与 registry：8 个名字、必填/可选字段、默认值、平台展示名/`bash` 别名、canonical 顺序；schema 与 executor 集合一致。
2. 纯文件工具：read 行号/大小/续读、write 覆盖+父目录、edit 唯一匹配/LF/BOM；模拟 AbortSignal 与原子 rename 中断。
3. Glob/Grep：C# 已有 corpus 的星号/递归/大小写、ignore dirs、逐项正则支持矩阵（未兼容项为阻断）、literal/context/line truncation、超大文件提示、limit/60 秒预算为部分结果；恶意回溯由 worker terminate 测试证明可取消。
4. ProcessRunner：超时、AbortSignal、非零退出、启动失败、头尾截断、并行 drain、退出后 pipe 持有者、进程树被杀且无孙进程遗留。
5. 编码：OEM/GBK、至少一种非 GBK OEM 的 capability/failure、UTF-8、多字节跨 chunk、截断接缝、cmd echo 剥离、Python UTF-8、PowerShell 无 BOM stdin。
6. ShellSession：cwd/env 跨调用、串行执行、唯一 prompt、随机 marker/粘连 marker、cmd echo、stdout/stderr drain、用户 exit、timeout/abort 后重建。
7. Node TUI 响应性：在慢读/慢扫描/命令期间继续处理 RPC interrupt 和 render delta；检查工具 IO 无同步 fs。
8. 最后由 coding-agent host 接线；兼容旧 RPC backend 时同一工具结果仍是字符串观察，保留现有 `tui/src/app/` 组件与状态语义。

迁移完成判据：上述离线测试在 Windows 与至少一个 POSIX 平台通过；输出和错误边界符合表格；正则支持
矩阵中 Di 既有用法均有显式兼容结论，未处理项不得标全兼容；GBK/UTF-8
样例无乱码；大输出内存有界；timeout/abort 杀整棵进程树；持久会话状态正确且可恢复；工具 IO 不阻塞
TUI event loop；老 TUI 仍能通过 RPC 使用相同 8 工具；所有路径相对 repo root，所有依赖版本已核实并
锁定。具体测试文件规划跟随 architecture 文档，不在此重定义测试目录映射。

关联：[`architecture.md`](architecture.md)、[`loop-and-state.md`](loop-and-state.md)、
[`sessions-and-compatibility.md`](sessions-and-compatibility.md)、
[`docs/modules/tools.md`](../../modules/tools.md)、[`docs/modules/agent-loop.md`](../../modules/agent-loop.md)、
[`docs/modules/sessions.md`](../../modules/sessions.md)、[`docs/tui-rpc.md`](../../tui-rpc.md)、
[`docs/interrupt.md`](../../interrupt.md)。
