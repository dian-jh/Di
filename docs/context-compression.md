# Di 上下文压缩系统设计

> 顶层跨模块设计文档。定义 Di 的上下文压缩系统：**现状与问题 / 设计目标 / 上下文分层（四种数据
> + 环境快照准稳定变体）/ 五层压缩机制 / 触发时机（token 阈值 + 时间 + 异常恢复）/ 预算与多级水位线
> / KV Cache 一致性 / 持久化 / 独立模块架构 / 验收基准 / 分阶段落地**。
> 唯一权威：本模块（`Core.ContextManagement`）的设计、触发时机、持久化布局一律以本文为准；
> 架构快照 / 依赖方向 / 数据流时序唯一权威仍为 `docs/architecture.md`，模块 ↔ 文档来源映射为
> `docs/modules/README.md`，功能全景与路线图见 `docs/roadmap.md`。
> 现状描述与源码锚点核对于 2026-10-15（`dotnet test` 779 用例全绿基线）。
> 设计参考：Claude Code 上下文压缩机制（5 层防御体系，github: ForceInjection/AI-fundamentals
> `08_agentic_system/context/claude-code-context-compression.md`）——本文借鉴其
> **渐进式降级 / 缓存优先 / 配对安全 / 全量可观测** 四哲学，对标对照表见 §10。

---

## 1. 现状与问题

### 1.1 目前怎么"管理"上下文

跨回合记忆由宿主 `Core/AgentLoop/AgentRunner.cs` 管理。每回合结束后：

```csharp
_history = SanitizeHistory(TrimHistoryByTokens(TrimHistory(result.Trajectory, _maxHistoryTurns), tokenBudget));
```

两条裁剪规则叠加（详见 `docs/modules/agent-loop.md`）：

- **轮数兜底**：`TrimHistory` 保留最近 `_maxHistoryTurns`（默认 10，`DefaultMaxHistoryTurns`）轮整回合，
  超出丢最旧整回合；
- **token 预算**：`TrimHistoryByTokens` 按当前模型 `ContextWindow × HistoryBudgetRatio`（默认 0.5）
  估算历史 token（`TokenEstimator`，~4 字符/token），超限从最旧开始逐轮丢，至少保留最近 1 轮。

### 1.2 三个致命问题

1. **纯丢弃式裁剪 = 不是压缩**。丢最旧整回合 = 把"移除旧记忆"当成压缩的全部。没有任何"产出"
   —— 既不保留关键结论（Task State），也不形成高密度知识表示。长会话后期，模型能"记得"的只剩
   最近 10 轮，早期的重要决策 / 失败根因全部丢失。
2. **裁剪根本不考虑 KV 缓存命中**。丢最旧 = 删的是请求前段（system prompt 之后）的轨迹消息：
   字节前缀从删除点起整体错位，**删除点之后的整段缓存全部失效**（包括增量累积的近期历史与尾部）
   —— 恰好把"该保护的前缀"与"该重传的尾部"一起打穿。当前仓库对 DeepSeek 前缀缓存依赖极重
   （`tokenUsage.CacheHitRate` 已上报、缓存是字节精确前缀匹配，见 `docs/modules/agent-loop.md`），
   裁剪后每轮都在为"缓存失效"买单。
3. **每回合都裁剪 = 频繁破坏缓存**。按 `ContextWindow × ratio` 每回合估算并裁剪，实际上是把
   "接近阈值时批量压缩"退化成"每轮都动头"——这违反第 4.1 布局原则里的缓存账：压缩是**一次性
   可控重建**，摊成持续 miss 是最差解。

### 1.3 设计目标

1. **控制长度与成本**（继承现有目标）：长会话 token 不超窗。
2. **提升思考质量**：压缩产出**高密度知识表示**（Task State / 归档摘要），比原始轨迹更利于模型使用。
3. **主动提炼，而非被动检索**：与其让模型在冗长上下文中自己找，不如主动提供提炼后的结构化知识。
4. **缓存友好**：压缩放弃"每轮都动头"；压缩事件是一次性前缀重建，压缩前/后记录 token 与缓存
   命中率，用数据验证缓存代价（见 §8.4）。
5. **渐进式降级**（借鉴 Claude Code）：从无损且极低成本的操作开始，逐渐过渡到有损操作，最后
   才是直接丢信息的保底——不到万不得已不丢信息（§3 五层排序即此）。
6. 压缩的价值是**把需要思考才能得到的结论，变成可以直接检索的知识**——这是 Task State 的定位。

---

## 2. 上下文分层：四种数据（+ 环境快照准稳定变体）

压缩系统对上下文做**分层**，每层有不同的生命周期与处理策略：

| 层 | 内容 | 生命周期 | 处理策略 |
|---|---|---|---|
| **Stable Prefix（稳定前缀）** | 系统提示词、工具定义（字节绝对稳定） | 跨回合复用 | **绝不动**（§4.1）：永不进入压缩范围 |
| **环境快照**（准稳定） | 工作目录最小化快照（`EnvironmentSnapshot`） | 内容恒定即稳定；变化时**以新消息追加**在历史末尾，不原地改写 | 与 Stable Prefix 同待遇：不压；被裁剪后由 `_lastSnapshotText` 机制重注入 |
| **Task State（任务状态）** | 目标 / 约束 / 已知事实 / 已确认根因 / 下一步 / 证据引用 —— 当前任务的**高密度投影** | 持久化、增量更新 | **持续维护**：决策点、失败教训、关键约束始终在线（双路径提取，§3.4） |
| **Trajectory（轨迹）** | 历史消息：user / assistant / tool 结果（含 reasoning 与 tool_calls） | 追加写、可归档 | **预算内保留**；溢出时按批次归档，**原始轨迹永不被压缩覆盖** |
| **外部数据** | 大体积工具输出（2 万行构建日志、超大文件） | 落盘，按需加载 | **不进入上下文**；模型只看到摘要/预览 + 引用（L1 工具结果预算控制，§3.1） |

> **Task State 不是完整轨迹的替代品，而是轨迹的一个高密度、可更新的任务状态投影**。
> 例：Agent 已读 20 个文件，发现 Bug 由空值处理导致。任务状态只需记录：
> - 已确认问题位于 `UserService.cs` 的某个方法；
> - 根因是缺少空值检查，证据来自具体代码位置；
> - 已修改代码，但尚未通过测试；
> - 测试命令是什么、失败了什么、下一步需要检查什么。
>
> 完整源文件和日志仍保存在磁盘上。以后需要重新确认实现细节时，读取对应文件即可，
> 不必把之前所有读取结果永久保留在上下文中。

---

## 3. 五层压缩机制（核心）

按"从最便宜到最贵"排序。**低层优先**：能用确定性规则就不调 LLM；能用工具结果预算控制
就不做压缩。触发时机（token 阈值 / 时间 / 异常恢复三路）见 §4.2 汇总表，预算与水位线见 §6。

| 层 | 机制 | 是否调 LLM | 延迟量级 | 信息损失 | 触发时机 |
|---|---|---|---|---|---|
| L1 | 工具结果预算控制（大输出落盘 + 摘要进上下文） | 否（确定性截断/摘要） | ~实时 | 最小 | 工具执行**后、进轨迹前**（事前）；软阈值时对已入上下文的大结果经 **L4 整组归档**复核（不原地改写，见 §3.1 缓存一致性规则） |
| L2 | 噪声删除 + 时间触发清理（确定性，不调 LLM） | 否 | <1ms | 最小 | 到达软阈值 / token 阈值；**gap>阈值缓存已失效时**直接占位符化（§3.2） |
| L3 | API 层微压缩（服务端上下文编辑） | 否 | — | 为零（本地不动） | 可选适配器，仅当服务端支持（§3.3） |
| L4 | 归档式摘要（逐轮独立归档 + Task State 更新） | 是 | 5~30s | 中等 | 到达软阈值，介于"读删"与"全量压"之间 |
| L5 | 全量压缩 + 响应式恢复（LLM 驱动，最后手段 + 熔断） | 是 | 数十秒 | 中~高 | 到达硬阈值且 L1-L4 后仍超限；或**provider 上下文溢出错误**触发（§3.5） |

> 与 Claude Code 五层防御的完整对标见 §10。核心差异：本系统把"会话记忆（SM）"显式建模为
> **Task State** 并持久化，把"缓存编辑微压缩"降级为**可选 L3**（DeepSeek 当前不支持），
> 其余机制同构。

### 3.1 L1 工具结果预算控制（事前）

**在工具执行完后立即控制结果大小**，而不是等整个上下文变大后再处理：

- **大体积输出 → 磁盘**：模型只看到摘要/预览 + 引用（`artifactRefs`）。完整结果写入
  `~/.di/sessions/.../<session>/artifacts/<tool>-<ts>.txt`（细节见 §7 持久化）。
- **既能被压缩、又不会被压缩**：Read 返回 200 行有用代码 → 原样保留不压；Bash 返回 2 万行重复
  构建日志 → 只保留错误附近的内容（**摘要进上下文 + 完整落盘**）。
- 摘要可以是：头部 + `…[截断 N 字符]…` + 尾部（现有 `Core/Tools/OutputBuffer.cs` 已是这个模式），
  也可以由确定性规则提取（错误行 / 最后 N 行），**不默认调 LLM**。
- **可清理的工具白名单**（借鉴 Claude Code `TOOLS_CLEARABLE_RESULTS`）：Di 的 8 个内置工具
  （注册名见 `Core/Tools/*.cs`）中，`read_file / grep / glob / 平台 shell 工具（向模型展示的名
  随平台：Windows 为 cmd、其他平台为 bash，`CoreTools.PlatformShellName`；内部注册键 `bash` 在
  Windows 上保留兼容别名）/ powershell / python` 的**结果内容**适合进 L1/L2 清理范围（纯检索 /
  执行产物，丢中间不影响协议）；`edit_file / write_file` 的结果可能含文件确认信息，默认**不清理**
  （详见 `docs/modules/tools.md` 的工具清单）。

**现状基础（部分能力已存在，避免重复造轮子）**：

- `read_file` 工具（`Core/Tools/ReadFileTool.cs`）已有 `MaxOutputLines = 2000` /
  `MaxOutputBytes = 64KB` 上限，并在超限时给出 `start_line` 续读协议——"Read 大文件"的预算控制已实现；
- `bash` / `powershell` / `python` 的进程输出已有 `OutputBuffer` 头尾预算（`HeadChars 6000` +
  `TailChars 18000`，`Core/Tools/OutputBuffer.cs`）——超长输出已截断（头 + 提示 + 尾）；
- 因此 **L1 的新增工作不是"从零给工具加预算"**，而是三件事：① 超预算工具输出**落盘
  `artifacts/`**、上下文只留摘要/预览 + 引用（`artifactRefs`）；② 把分散在各工具的截断参数
  （预算 / 白名单 / 摘要策略）统一进 `BudgetPolicy`；③ 对"已入上下文的大结果"做复核清理。
  现有截断是**内存内丢弃**（中间不可恢复），本层补的是**磁盘留存 + 可引用**。

**缓存一致性规则**：工具结果一旦以"完整"或"摘要"形式进入一条**已持久化**的轨迹记录，
该条记录的表示**立即冻结**——后续轮次**不再原地改写同一条历史消息**（避免反复切换完整 ↔
摘要，那会持续性击穿缓存）。"复核压缩已入上下文的大结果"一律**走 L4 整轮归档**：旧表示冻结，
新表示以归档摘要形式进入后续视图，绝不原地改。

### 3.2 L2 噪声删除 + 时间触发清理（确定性，不调 LLM）

适合删除 / 裁剪的内容：

- 重复的状态轮询结果；
- 已被后续结果取代的中间进度信息；
- 过长的重复日志、无关网页模板；
- 已被明确记录的冗余展示内容。

**但"没有被模型直接引用"≠"没有价值"**（关键）。例：第一次测试失败、修改后第二次测试成功，
第一次失败记录可能仍包含定位根因的信息——**归档它（L4），不简单判定为噪声**。

**时间触发清理（Time-Based MC，借鉴 Claude Code `gapThresholdMinutes`）**：当 `gap > 阈值`
（默认 60 min，期间无交互）时，API 前缀缓存**已自然过期**——保护缓存的意义消失。此时可确定性
地将旧工具输出替换为 `[旧工具结果已清理]` 占位符（保留 `tool_use`/`tool_result` 配对），硬性
节省重传 token，无需等待 token 阈值触发。这是"缓存优先"哲学的推论：**缓存有效时不动缓存，缓存
失效时才硬清**。

**注意：缓存失效 ≠ 内容失去价值**。gap 超时只说明"再保护缓存已无意义"，不说明被清理的工具
输出对当前任务无用——其中可能仍含未解决的失败根因。因此时间触发清理**默认走 L4 归档**（保留
可召回摘要），只有在具备"已被后续结果取代 / 纯轮询噪声"这类确定性判据时才硬删；策略**可配置、
可验证**（§8.4 用 `fact_fidelity` 回测清理是否误伤根因），而非无条件删除规则。

**编码 Agent 的硬约束——工具调用协议完整性**：删除旧工具结果时不得留下不完整的工具调用协议。
一个 assistant 消息发出了三个 `tool_calls`，就必须保留或重建这三个调用与对应结果的关联；
**绝不允许**任删其中一条消息破坏消息结构。压缩以**完整消息组 / 完整历史轮次**为单位（见 §4.3）。

### 3.3 L3 API 层微压缩（可选适配器，不默认依赖）

利用模型 API 的服务端上下文编辑能力，指示服务端从有效上下文中**移除**指定旧工具结果，
本地消息保持不变（对应 Claude Code 的 `cache_edits` 路径：缓存仍有效时定点清除工具缓存，
**不修改本地消息、不破坏剩余缓存命中率**）。**适用条件（当前 DeepSeek 不支持则直接跳过本层）**：

- 必须确认所用 API（当前为 DeepSeek）确实提供上下文编辑能力；
- **本地持久化轨迹仍然保留**（绝不因服务端移除而删本地）；
- 服务端编辑能力不一定跨模型 / 跨 API 兼容；
- 修改历史前缀后，后续缓存可能无法复用（取决于提供商的缓存实现）——**代价一次重建**，
  所以只适合在"反正要重建"的**临近溢出**时刻使用，不频繁触发；
- 服务端编辑的上下文与本地重建的上下文必须有明确的**版本 / 状态关系**（§4.5 contextVersion）。

当前 DeepSeek API 未提供所需上下文编辑功能 → **本层不进入 MVP 实现**，作为可选适配器预留
（与 §9 阶段四对应）。

### 3.4 L4 归档式摘要（核心层，重点实现）

不做"把前 100 轮轨迹合并成一个不断覆盖的长摘要"。而是**每一批历史生成一份独立的归档摘要**，
任务状态单独维护：

```
Session
├── TaskState.json          # 当前有效任务状态
├── Events.jsonl            # 原始执行事件，追加写
└── Archives
    ├── archive-0001.json   # 覆盖 event seq 1..42
    ├── archive-0002.json   # 覆盖 event seq 43..80
    └── ...
```

**关键点**：

- 每轮**独立**归档（像 `git log` 保留每轮独立记录，而非 `git squash` 合并成一条）——保留逻辑脉络；
- **Task State 双路径提取**（借鉴 Claude Code SM Compact 的"优先零 LLM"路由）：
  1. **零 LLM 确定性路径**：由已完成动作 / 事件直接落子集（无新增 LLM 调用，后台 <10ms）；
  2. **LLM 提炼路径**：需要归纳时调用压缩模型，且**在隔离上下文 / 子代理中执行，不占主对话流
     的 token 与缓存**（Di 复用的 `AgentRunner` 骨架，见 `docs/roadmap.md` Phase D 子代理）；
  两条路径由双重阈值控制频率（token 水位 × 距上次提取的轮数），避免每回合都提取。
  **依赖标注**：LLM 提炼路径依赖 roadmap Phase D 能力（子代理）；该能力落地前，阶段二先实现
  确定性路径；
- 归档摘要**不是**原始事件的替代品：审计、恢复、重新压缩仍可依据 `fromSequence`/`toSequence`
  找到对应的原始 Event 记录（§7.2 引用回溯）；
- **压缩只修改发送给模型的上下文视图，不删除原始轨迹**。

**压缩指令规范（强制保留清单，借鉴 Claude Code §5.2）**：L4/L5 的摘要指令模板必须要求模型
在极少量 token 内重点保留：

1. **目标与约束**（当前 goal、不可违背的硬约束）；
2. **关键决策 + 失败原因**（`failedAttempts`：什么试了、为什么不行——第一次失败记录常含根因）；
3. **技术概念 / 代码模式 / 完整代码片段**（关键文件的关键片段按原样保留，不 paraphrase）；
4. **测试命令与最近结果**（`nextSteps` 依赖）；
5. 格式化为**两阶段**：先起草（`<analysis>`，随后剥离），最终只保留 `<summary>` 结论块——
   与 `ChatMessage.Reasoning` 的关系：归档摘要**不携带 reasoning**，只保留结论（原始 reasoning
   仍在 Events/日志里，可审计）。

每份归档至少包含：

```json
{
  "archiveId": "archive-0001",
  "schemaVersion": 1,
  "fromSequence": 1,
  "toSequence": 42,
  "goal": "修复用户查询接口的空值处理问题",
  "constraints": [],
  "decisions": [],
  "facts": [],
  "completedActions": [],
  "failedAttempts": [],
  "openQuestions": [],
  "artifactRefs": []
}
```

`fromSequence` / `toSequence` 说明归档覆盖哪些事件（对应 Events.jsonl 的序号）。
实现进一步增加：Schema 版本、压缩模型信息、状态校验字段（§7.2）。

### 3.5 L5 全量压缩 + 响应式恢复（最后手段，熔断）

**主动路径（token 触发，两阶段）**：

1. **先重建任务状态**：基于现有 Task State + 近期轨迹 + 历史归档，生成一份**新的结构化状态摘要**；
2. **再裁剪旧轨迹**：只保留近期执行历史 + 最新状态摘要 + 必要的关键证据引用。

**响应式路径（异常触发，借鉴 Claude Code Reactive Compact）**：当模型层报告**上下文长度溢出类
错误**时，不等下一轮，按**同样的渐进降级**处理：先清理可清理的工具结果（L1/L2），再归档旧历史
（L4），仍超限才丢弃最旧历史轮次并重试（近似"PTL Recovery"），**带重试上限**（默认 3，防无限
丢历史）。

**实现前置（当前代码缺失，阶段三须先补，见 §9）**：

- `LlmErrorCodes`（`Core/Llm/LlmException.cs`）**现无"上下文溢出"错误码**，非 2xx 一律翻译为
  `RateLimited` / `MissingCredential` / 其余 `InvalidRequest`（见 `docs/modules/deepseek.md`）。
  响应式触发须先**新增 `CONTEXT_OVERFLOW` 码**，并在 `DeepSeekAdapter` 翻译层把**明确的**上下文
  超限信号（如错误信息含 `maximum context length` / `prompt too long` 之类）映射进去——**不得把
  全部 400/413 笼统归为上下文溢出**（400 也可能是请求格式错误、413 也可能是其他载荷超限），
  否则会把正常错误路径误导向"丢历史"的响应式压缩；
- 当前 `ReAct` 对不可重试 `LlmException` 直接以 `AgentStopReason.Error` 干净结束
  （`Core/AgentLoop/ReAct.cs` 的 `Fail`）——需在 `AgentRunner` 层拦截 `CONTEXT_OVERFLOW`：
  先触发压缩、压缩成功后重跑本回合，而不是直接收尾；
- 带内故障路径也要覆盖：provider 返回错误不抛异常、以流内 `Finish(Error)` 结束
  （见 `Core/Llm/LlmException.cs` 注释）——响应式触发不能只挂在异常路径上。

**故障语义**：

- 若阶段一摘要**无法通过校验** → **不覆盖旧状态**，保留旧版本，记录失败原因，采用保守裁剪方案；
- **熔断器**：连续 **3 次**全量压缩失败后**停止自动重试**（借鉴 Claude Code
  `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`，避免把会话困在"反复压缩失败"的烧钱循环）——
  **主动压缩与响应式压缩分别计数**（两类路径的失败语义不同，混计会过早/过晚熔断）。
  熔断后降级：降低压缩目标 / 改用确定性裁剪 / 返回"需缩小任务范围"的结构化错误（§7.4）。

---

## 4. 关键设计原则

### 4.1 布局原则：稳定前缀不动 + 动态/静态边界

- **System Prompt 和 Tool Definitions 永远不动**——这是上下文最前面的"静态前缀"，KV Cache 持续缓存。
- 压缩的对象是**对话历史中的 tool results**：用压缩后的摘要替换原始工具输出时，**替换位置之后的
  缓存失效，但之前的缓存仍然有效**。
- 借鉴 Claude Code：在请求内物理切分"**静态复用区**（系统提示词、CLAUDE.md 类规则）"与"**动态
  会话区**（工作目录、近期状态）"的边界标记（对应其 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`），
  最大化缓存复用、避免核心约束被稀释。Di 的对应物：`ReAct.BuildContext` 的现有布局 +
  压缩系统的视图构建（§5.2）共同保证稳定区字节不变、动态区只在末尾。
- 这是**有意识的权衡**：不压缩 → 上下文膨胀到超出窗口限制，任务直接失败；压缩 → 损失部分缓存，
  但上下文长度可控且信息密度更高。**因此压缩频次要权衡**——频繁压缩会频繁破坏缓存，
  **最好在上下文接近阈值时批量压缩，而不是每轮都压**。

### 4.2 压缩时机与位置

压缩**不是在单次 API 调用的过程中**修改上下文，而是在**两次 API 调用之间**，由 Agent 框架对
消息列表做预处理。触发时机是**三路并行的**：

| 触发路 | 条件 | 对应机制 |
|---|---|---|
| **token 阈值** | `B_predicted ≥` 软 / 硬水位线（§6.2） | L2 → L4（含对已入上下文大结果的复核归档，§3.1）→ L5（必要时） |
| **时间** | `gap >` 缓存失效阈值（默认 60min） | L2 时间触发清理（§3.2） |
| **异常恢复** | provider 上下文溢出错误 | L5 响应式压缩（§3.5） |

**位置（两层）**：

- **工具执行后**（L1）：立即控制结果大小（不进入上下文 / 摘要 + 落盘），防止膨胀；
- **回合结束时**（L2/L4/L5）：对已持久化的历史做归档 / 摘要 / 更新 Task State。

### 4.3 单元：完整消息组 + 递归保护

`ChatMessage` 词汇（`Core/Llm/ChatMessage.cs`）中，assistant 的 `tool_calls` 与其响应的
`tool_result` 是**一个不可分割的工具调用组**。压缩器必须：

1. 识别**完整的消息组**（一轮 assistant tool_calls → 对应 tool results）；
2. 以**完整历史轮次 / 工具调用组**为单位进行归档（L2/L4 的删除 / 归档永不拆组，永不分离共享
   同一调用 ID 的消息块）；
3. **在 Context Builder 层生成一个新的、合法的上下文视图**，而不是直接对持久化的原始消息列表
   做大量原地修改（原地修改极易破坏消息序列，且丧失版本化能力）；
4. **递归保护（防"压缩自身的压缩"）**：压缩过程（summarizer 的输入）本身消耗上下文。必须为压缩
   动作设置**独立预算 / 隔离上下文**（SM 的双路径 + 子代理隔离正是为此），并禁止"压缩动作
   触发自身压缩"的递归——否则压缩器会因上下文超限而陷入无限压缩。

### 4.4 "压缩即理解" + 摘要规范

- 有效的压缩需要**深层语义理解**：L4/L5 的 LLM 驱动部分接近主模型能力，形成"**模型调用模型**"
  的递归架构——显式压缩的结果**可审查、可跨会话复用**。
- 摘要的**强制保留清单**与**两阶段格式**见 §3.4。
- 虽然每次压缩是一次额外的 LLM 调用，但对比节省的 token 成本与提升的任务成功率，ROI 极高
  （外部实验显示上下文感知压缩将 token 使用量减少 75% 以上；成本账是我们自己的 `compression_cost`
  指标，§8.3）。

### 4.5 contextVersion（版本与可观测）

压缩后必须能追踪"上下文发生了什么变化"：

- 每次压缩记录：**上下文版本、压缩位置（删除 / 归档的 sequence 区间）、压缩前后 token 数、
  触发原因（token / 时间 / 异常）与重试次数**；
- 服务端编辑的上下文与本地重建的上下文之间，用 **contextVersion** 建立版本 / 状态关系（L3）；
- 据此**观察缓存命中率变化**（`TokenUsage.CacheHitRate`，`Core/Llm/TokenUsage.cs`）——
  用数据验证每次压缩的缓存代价，而不是拍脑袋（§8.4 埋点）。

---

## 5. 架构

### 5.1 模块边界

- **压缩逻辑不塞进 ReAct 循环**。`ReAct`（`Core/AgentLoop/ReAct.cs`）保持**简洁、功能单一**：
  它只拼装上下文、执行循环、转发事件。压缩是`AgentRunner`级（跨回合宿主）的职责。
- 新增独立模块 **`Core.ContextManagement`**（源码 / 测试落点见 §5.4；模块 ↔ 文档 / 源码 / 测试
  映射在实现后登记到 `docs/modules/README.md`）：

```
Core.ContextManagement/
├── ContextManager.cs        # 外部门面：三路触发（token/时间/异常）后执行压缩；注入 Compactors + 预算策略
├── ICompactor.cs            # 压缩器契约（完整消息组 / 整轮 → 归档/摘要/删除，§4.3）
├── BudgetPolicy.cs          # 多级水位线、B_input / B_predicted 计算（§6）
├── TraceEstimator.cs        # 按消息列表估算 token（复用 TokenEstimator ~4 字符/token 口径）
├── ArchiveStore.cs          # 持久化抽象：原始轨迹（Events）+ 归档 + Task State（§7）
├── CompactingExecutor.cs   # L1：执行时工具结果预算控制（包装 IToolExecutor，摘要 + 落盘，白名单见 §3.1）
├── Compactors/
│   ├── NoiseTrimmer.cs          # L2：确定性噪声删除 + 时间触发占位符化（不调 LLM）
│   ├── ArchiveSummarizer.cs     # L4：归档式摘要 + Task State 更新（LLM 驱动，子代理隔离）
│   ├── FullCompactor.cs         # L5：全量压缩 + 熔断（LLM 驱动）
│   └── ReactiveCompactor.cs     # L5：响应式压缩（provider 溢出错误 → 丢最旧重试，上限 3）
└── Events/                  # 压缩遥测事件（ContextCompacted 等，写压缩产物 + 事件总线旁路，§8.4）
```

**与 `AgentLoop` 的接线方式**：`AgentRunner` 在每回合结束用 `ContextManager` 处理历史，
而不是自己写死 `TrimHistory`/`TrimHistoryByTokens`。`AgentRunner` 仍保留"统计 + 决策"，
**压缩的实际执行委托给 `ContextManager`**；`ReAct` 无感知。实现细节、接口签名与依赖图见
实现时随代码的 `docs/modules/context-management.md`（新建）。

**快照重注入的迁移义务**：现有"环境快照被裁剪 → 复位 `_lastSnapshotText` → 下一回合重注入"
逻辑（`AgentRunner` 裁剪路径尾部，见 §1.1）随压缩接管而迁移到 `ContextManager`——压缩路径
裁剪掉快照消息后必须同样复位该标记，否则去重标记会阻止重注入，长期会话失去环境上下文。

**L1 的执行缝（不改 ReAct）**：工具结果预算控制在"执行后、进轨迹前"拦截。现有缝是
`IToolExecutor` 包装层——`SkillAwareExecutor`（`Core/Skills/SkillTools.cs`）已示范了
"把执行器包一层、拦截特定调用"的模式（见 `docs/modules/skills.md`）。L1 复用同一模式：
`CompactingExecutor` 包在 `IToolExecutor` 外，按 `BudgetPolicy` 决定结果进轨迹的表示
（完整 / 摘要 + 落盘）。`ReAct` 全程无感知。

### 5.2 上下文视图构建

- **Context Builder 层**生成一个新的、合法的上下文视图（`IContextView`），而不是原地修改
  持久化消息列表。视图的**顺序**（缓存安全）：

```
[稳定前缀（system prompt + 工具定义）]        ← 字节绝对稳定，跨回合命中
+ [归档摘要区（注入 Archives 可检索摘要）]               ← 随压缩事件一次性写入（低频）
+ [压缩边界标记 compact_boundary]            ← 显式告知模型"此前的已归纳"（借鉴 Claude Code）
+ [近期轨迹（预算内保留）]                     ← 压缩之间严格追加、字节稳定
+ [易变 SystemContext + Task State 增量]      ← 请求末尾，每轮重发（代价有界）
```

- **Task State 放置规则（缓存关键）**：Task State 摘要**只进请求末尾的易变区**，**不插**在
  归档摘要与近期轨迹之间——否则 Task State 的增量更新会击穿刚累积的字节稳定历史。归入末尾后，
  其每轮变化只影响尾部（本来就在重传），近期轨迹缓存无损。
- 视图构建时逐条校验工具调用协议完整性（§4.3）。
- **归档摘要区自身有界、按相关性选择**：随压缩次数增长，归档区只注入**近窗（最近 N 批）**内
  **与当前 Task State 相关性最高**（goal / decisions / facts 命中优先）的归档摘要；更早或低相关的
  归档摘要折叠进 L5 的"最新状态摘要"，或留在视图外按 `archiveId` 引用、按需读取——否则归档区随
  压缩次数线性增长，压缩的稳态收益被自己的产物稀释。窗宽、相关度阈值与折叠时机在阶段二用
  §8.3 的 `compression_ratio` 校准。
- 压缩事件 = 一次性前缀重建（可接受）；压缩之间 = 严格追加、字节稳定（缓存累积）。

### 5.3 依赖方向（新增模块在既有图中的位置）

```
Di.Cli ──► Core.AgentLoop（IAgentRunner ──► ContextManager）
                └──► Core.ContextManagement
                       ├─ Core.Llm（ChatMessage / TokenEstimator / TokenUsage / IChatModel 工厂）
                       ├─ Core.Sessions（Events 追加写 / Archives / TaskState 落盘）
                       └─ Core.Tools（IToolExecutor：CompactingExecutor 的 L1 执行缝）
```

`Core.AgentLoop → Core.ContextManagement → Core.Llm / Core.Sessions / Core.Tools`。
压缩（L4/L5）需要调模型 → 通过注入的 `IChatModel` 工厂，**ContextManagement 不直接依赖具体厂商**。
模块 ↔ 文档 / 源码 / 测试映射唯一权威见 `docs/modules/README.md`（本模块实现后新增一行）。

### 5.4 测试与持久化落点

- 持久化：`Core/Sessions/SessionLog.cs` 已把每回合落 API 兼容 format 的 JSONL（Events.jsonl 未来迁入
  Sessions 抽象，§7）。压缩存档（Archives / TaskState.json / artifact）落 `~/.di/sessions/.../`,
  见 §7。
- 测试：`Di.Tests/ContextManagement/`。固定回归场景见 §8.2（与 `docs/modules/agent-loop.md` 的既有
  单元裁剪测试并存，作为"宽松 / 严格"两档）。

---

## 6. 预算与触发

### 6.1 输入预算公式

\[
B_{\text{input}} =
B_{\text{window}} -
B_{\text{output}} -
B_{\text{margin}}
\]

- `B_window`：模型的总上下文容量（`ModelSpec.ContextWindow`，DeepSeek 1M，见 `Core/Llm/ModelCatalog.cs`）；
- `B_output`：给模型输出预留的 token。**必须计入压缩动作自身所需的摘要输出空间**（借鉴 Claude Code
  `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000` 的显式预留）——压缩也是一次 LLM 调用，需要输出预算；
- `B_margin`：给估算误差、动态提示、工具定义等预留的安全空间（可为 ContextWindow 的 10%，
  或固定值——实现时按实际数据校正）。

当前实现用 `ContextWindow × HistoryBudgetRatio(0.5)` 直接当预算，**没有**给输出 / 安全空间留余量。
新公式显式计入这两项。

### 6.2 多级水位线（渐进降级）

借鉴 Claude Code 的 warn / autoCompact / blocking 三级梯度（其 Opus 200K 实例：
warn≈82% 提示、auto≈93% 主动压、blocking≈98% 阻塞），Di 定义相对 `B_input` 的三级：

| 水位线 | 触发条件 | 动作 |
|---|---|---|
| **soft（软阈值）** | `inputs ≥ SoftRatio`（默认 70%） | L2 噪声删除 + L4 归档旧轨迹（含**复核压缩**已入上下文的大工具结果，走整组归档不原地改，§3.1）+ 更新 Task State + 重新计算 token |
| **hard（硬阈值）** | `inputs ≥ HardRatio`（默认 80%） | L4 压缩工具结果与旧轨迹，必要时 L5 全量压缩 |
| **blocking（阻塞线）** | `inputs ≥ BlockingRatio`（默认 90%） | 停止自动继续：先强制压缩成功，或把"上下文已满、需缩小任务范围"返回给用户 |

默认 70% / 80% / 90% 为初始值，阶段四（§9）按 §8 指标实测校准。三个百分比是相对 `B_input` 的
**比例**，随模型窗口缩放，不写死绝对 token 数。

### 6.3 预测性触发（提前量）

**据增长速度提前触发**，不在超限后才反应：

\[
B_{\text{predicted}} =
B_{\text{current}} +
B_{\text{next-tool-estimate}} +
B_{\text{next-output-reserve}}
\]

如果最近一轮突然增加了 30,000 token，不能等到下一轮已经超过硬限制才反应。
`B_next-tool-estimate`：工具结果的**实际长度在执行完、进轨迹前即可测得**
（`OutputBuffer.TotalChars`）——L1 的控制点正是"执行后、进轨迹前"（§3.1），无需执行前预测；
仅当需要执行前先验时，用"该工具类型的历史平均结果长度"作估计。
`B_next-output-reserve`：为**下一轮输出**预留的 token——预测不能只看输入增量，随即到来的输出
同样会占窗。

**估算口径**：优先用对应模型的 tokenizer 精确计数；当前只有 `TokenEstimator`（~4 字符/token）
估算时，误差由 §6.1 的 `B_margin` 吸收——margin 须按实测误差校准，而非拍定。
路径：本回合已累计 `B_current` + 本工具结果长度 > soft → 该结果**改用摘要 + 落盘**（L1），
而不是先把 3 万 token 灌进上下文再压。

---

## 7. 持久化

### 7.1 布局（每会话目录）

```
~/.di/sessions/YYYY/MM/DD/<session>/
├── session.jsonl            # 原始执行事件（Events.jsonl，追加写，未来迁入 Sessions 抽象）
├── TaskState.json           # 当前有效任务状态（原子替换）
├── archives/
│   ├── archive-0001.json
│   ├── archive-0002.json
│   └── ...
└── artifacts/               # L1 大输出落盘
    ├── tool-bash-<ts>.txt
    └── tool-read-<ts>.txt
```

> **与现状的边界**：当前 `SessionLog` 是平铺单文件（`session-{时间戳}-{id}.jsonl`），**没有会话目录**。
> 本系统的持久化以**每会话目录**为容器；落地方案：阶段二先做"会话目录 + 压缩产物"
> （`<session>/archives`、`<session>/TaskState.json`、`<session>/artifacts`），原始 Events 继续用
> 现有 `SessionLog` 单文件（或按其现有路径放入目录），**不破坏现有会话文件的读取 / 重放契约**
> ——迁移边界在阶段二明确并同步 `docs/modules/sessions.md`。

- `Events.jsonl`：原始执行事件，追加写（现有 `SessionLog.cs` 已是 append-only，按行 flush）；
- `Archives`：每次归档的**结构化摘要**，各自保留覆盖的事件范围；
- `TaskState.json`：当前有效任务状态，由已知事实、事件和归档更新而来；
- `artifacts/`：L1 工具结果预算控制时，大体积输出落盘 + 摘要进上下文。

### 7.2 归档与引用回溯

- Archive 内的 `fromSequence` / `toSequence` 对应 Events.jsonl（`SessionLog.ordinal`）的序号区间；
- **归档摘要不是原始事件的替代品**：审计、恢复、重新压缩，仍可依据事件序号找到对应的原始记录；
- Schema 版本（`schemaVersion`）防止旧归档被新压缩器误读；
- **校验**：压缩（重建）后若摘要无法通过校验 → 不覆盖旧状态（L5 第一阶段的故障语义）。

### 7.3 TaskState.json 的最小字段

```json
{
  "schemaVersion": 1,
  "goal": "修复用户查询接口的空值处理问题",
  "constraints": ["不改变 GetUserList 的返回类型（外部契约）"],
  "verifiedFacts": [
    { "text": "UserService.cs 的 GetUserList 中 Users 为 null 导致 NRE",
      "status": "verified", "sourceSequence": 37 }
  ],
  "hypotheses": [
    { "text": "OrderService 可能仍存在同类空值问题",
      "status": "hypothesis", "sourceSequence": 41 }
  ],
  "decisions": [],
  "failedAttempts": [],
  "nextSteps": ["在 UserService.cs 加入空值保护后运行单测"],
  "openQuestions": [],
  "evidenceRefs": ["UserService.cs:42", "archive-0001"],
  "updatedFrom": "archive-0002"
}
```

> **与归档字段的映射（投影时归一）**：归档 `facts` → Task State `verifiedFacts`、`artifactRefs` →
> `evidenceRefs`；归档 `completedActions` 参与推导 `nextSteps`；`constraints`（§3.4 强制保留清单
> 第 1 条的"不可违背硬约束"）两侧同义，是 §8.2"三字段"中与 `goal` / `nextSteps` 并立的那一字段。
>
> **事实完整性铁律**：`hypotheses`（推断）**不得**在无显式证据时升级为 `verifiedFacts`；计划
> （`nextSteps`）不得记为已完成动作；未通过验证的修改不得记为成功修复。事实以 `supersedes`
> 指向被替代旧事实 + `sourceSequence` 溯源修订，而非静默改写——这是 §8.4 `status_confusion_rate` /
> `fact_fidelity` 两个保真指标的落点。

### 7.4 压缩事务与一致性

每次压缩是一次**幂等事务**，带唯一 `compactionId`。推荐序列：

1. 确定待归档事件范围（`fromSequence..toSequence`）；
2. 生成候选归档 + 候选 Task State；
3. 校验结构、证据引用与事件范围（§7.2 / §7.3）；
4. 写**临时文件**（`.tmp`），不落最终路径；
5. 持久化归档 / 状态版本；
6. **原子替换**（rename）生效新状态；
7. 记录"提交完成"事件（§8.4 埋点）；
8. `ContextBuilder` 用新版本重建视图（§5.2）。

**恢复规则**：原始事件**必须先**持久化，压缩产物是派生物；同一事务重试**不得重复创建**逻辑
归档（`compactionId` 幂等）；归档与 Task State 间记录版本关系（`updatedFrom`）；崩溃后靠临时文件
与 `compactionId` 识别**未完成事务**并丢弃；校验失败**保留旧状态**；归档失败**不破坏原始轨迹**
（产物独立于 Events，§7.1）。第一版用文件系统 + 版本化 JSON 实现，不引入数据库事务。

**故障语义收口**（承接 §3.5 熔断降级）：压缩失败后的三档降级——降低压缩目标 / 改用确定性裁剪 /
返回"需缩小任务范围"的结构化错误——统一在此定义。

---

## 8. 验收基准

> 怎么判断压缩系统真的做得好？**不以压缩率论成败**。一个摘要压缩率达到 95%、却把任务约束和
> 关键失败原因全部丢掉的系统没有实际价值。验收 = 硬门槛（阻断合入） + 优化指标（驱动调优），
> 全部相对**"同任务集、无压缩基线"**衡量——脱离基线的绝对值没有意义。

### 8.1 判定原则（三金指标）

- **`task_success_rate`（任务成功率）**：压缩后仍能完成任务的比率。**只有压缩后仍然能完成任务，
  才算真正实现了上下文管理的价值**。操作定义：定长任务套件（§8.4）上客观断言通过（测试通过 /
  文件符合预期 / 停因分布正常），同一套件跑"无压缩基线"对照。
- **`repeated_tool_call_rate`（重复工具调用率）**：压缩后模型重复发起**已完成的**同一工具调用
  （同工具 + 同参数签名）的比率——直接反映压缩是否让模型"失忆"、丢失了"已完成"信息。
- **`compaction_failure_rate`（压缩失败率）**：压缩尝试中失败（校验不通过 / 熔断 / 响应式超限）
  的比率——压缩本身必须可靠。

> **保真度门限（与三金指标同等重要）**：`constraint_retention_rate` / `fact_fidelity` /
> `status_confusion_rate`（§8.4）直接量化"压缩是否丢了关键约束与事实、是否把假设误判为事实"——
> 这是 §8 引言"不以压缩率论成败"的具体化，亦是 `task_success_rate` 波动的下游归因。

### 8.2 固定回归场景（全部通过 = 硬门槛集）

| 测试场景 | 通过标准 |
|---|---|
| 连续执行大量工具调用 | 任意回合估算输入 ≤ `B_input`（不超配置预算） |
| 工具输出突然暴增（单轮 +30k） | `B_predicted` 触发 L1 摘要化，下一轮请求未超限（不等超限才反应） |
| 压缩后继续执行 | 任务目标、约束和下一步行动保持正确（Task State 三字段在线；套件成功率 ≥ 基线阈值） |
| 模型生成无效摘要 | 旧状态不被覆盖（保留旧版本），能够恢复（用旧版本重跑成功） |
| 连续压缩失败 | 熔断器生效（连续 3 次后停），不会无限调用模型（调模型计数为 0） |
| 重复运行压缩 | 不会重复压缩已经归档的相同事件（同一 `fromSequence..toSequence` 幂等，归档数不增） |
| 任务中断后恢复 | 能从原始轨迹和有效状态继续运行（Events + TaskState 重建视图后 next-step 正确） |
| 工具调用跨越压缩边界 | 消息协议完整，调用 ID 关联正确（每条 `tool_use` 都有对应 `tool_result`；请求被 provider 接受） |
| 缓存优化 | 记录输入 Token、缓存命中情况和压缩开销；压缩频率低（接近阈值才压） |

落点：`Di.Tests/ContextManagement/`（单测注入**确定性假压缩器 / 假模型**，不花真钱、结果可断言；
端到端用固定任务套件跑基线对照）。

### 8.3 定量基准（Go / No-Go）

| 指标 | 初始基准 | 性质 |
|---|---|---|
| 输入峰值 ≤ `B_input` | 长会话（≥50 轮 / 模拟 50 万+ token）峰值不超预算 | 硬门槛 |
| `task_success_rate` | ≥ 无压缩基线的 95%（允许 ≤5% 损失） | 硬门槛 |
| `repeated_tool_call_rate` | ≤ 无压缩基线 + 2 个百分点 | 硬门槛 |
| `compaction_failure_rate` | ≤ 5%；且熔断在连续 3 次后生效 | 硬门槛 |
| 归档幂等 | 同一 sequence 区间只归档一次 | 硬门槛 |
| 无效摘要恢复 | 校验失败不覆盖旧状态、可回滚 | 硬门槛 |
| `compression_ratio` | 观察带 [2x, 20x]，不设死目标；指导批次大小 | 优化指标 |
| `compression_latency` | 单次 L4 ≤ 5s（L5 允许更久但须计时上报） | 优化指标 |
| `compression_cost` | 单次压缩成本 ≤ 本次压缩所省上下文成本 10%（ROI 约束） | 优化指标 |
| 缓存恢复 | 压缩事件后下一批次的 `cache_read` 恢复到压缩前水平 ≥ 80% | 优化指标 |
| `recovery_success_rate` | 压缩 / 中断后从 Events + TaskState 重建并继续（§8.2 场景）的成功比率，目标 100% | 优化指标 |
| 保真度（`constraint_retention_rate` / `fact_fidelity` / `status_confusion_rate`） | 关键约束与黄金事实集压缩后保留，`status_confusion_rate` 趋 0（§8.4） | 优化指标 |

硬门槛不达标 = 系统不合格，阻断合入；优化指标不达标 = 进入阶段四调优。

### 8.4 指标记录与测量（全埋点，借鉴 Claude Code `tengu_` 系列）

- **每个压缩动作都埋点**（触发原因 / 前后 token / 重试次数 / contextVersion），随压缩产物
  （archive / TaskState 元数据）留存——**不扩 RPC 线协议**，可离线聚合（扩展 `di --stats` 出压缩看板）。
- **缓存测量复用现有**：`SessionLog` 的 `task_complete.usage` 已记录 `cache_read/cache_write`
  与 `CacheHitRate`（`Core/Llm/TokenUsage.cs`），`di --stats <file>` 已做会话级聚合。
- **吞吐指标**：`input_tokens_before / input_tokens_after`、`compression_ratio`、`compression_latency`、
  `compression_cost`、`cache_hit_tokens`、`repeated_tool_call_rate`、`compaction_failure_rate`、
  `recovery_success_rate`、`task_success_rate`、`constraint_retention_rate`、`fact_fidelity`、
  `status_confusion_rate`、`artifact_retrieval_success_rate`。
- **保真度指标测量**：`constraint_retention_rate` / `fact_fidelity` / `status_confusion_rate` 用
  **黄金事实集**（定长任务套件中预先标注的"必须保留"约束 / 事实 / 失败原因）在压缩后对照检出——
  `fact_fidelity` = 命中率，`status_confusion_rate` = 假设升级为事实 / 计划误记为完成 / 未验证修改
  误记为成功的占比。`artifact_retrieval_success_rate` = 按 `artifactRefs` 重新读取落盘产物成功的比率
  （验证 §3.1"磁盘留存 + 可引用"真的可用）。
- **回归工具链**：单测注入确定性假模型 / 假压缩器（`Di.Tests/ContextManagement/`）；
  端到端用固定任务套件（roadmap Phase E 评估集）跑"无压缩基线 vs 有压缩"对照。
- **记账约定**：L4/L5 的压缩 LLM 调用是**独立的成本中心**——不计入回合的
  `AgentResult.Usage` / `TurnCompleted`（那是主循环的语义），单独记 `compression_cost` /
  `compression_latency`，随压缩产物留存；否则回合成本被压缩动作污染，`di --stats` 会失真。

---

## 9. 分阶段落地（实现顺序）

**不建议第一版就把五层机制全部实现**。按独立开发 harness 的阶段，顺序如下：

| 阶段 | 内容 | 说明 | 阶段验收（§8） |
|---|---|---|---|
| **阶段一：Token 预算 + 工具结果控制** | 给 `read_file` / `grep` / `glob` / 平台 shell 工具 / `powershell` / `python` 等工具设置输出预算（白名单见 §3.1），完整结果归档到文件；实现 70% / 80% 水位线触发机制（本阶段触发动作限 L1 预算控制 + L2 噪声清理，L4 归档随阶段二上线）+ 超限保护 | 把现有"每轮丢最旧"改为预算制 + L1 | 场景：连续工具调用 / 输出暴增不超限 |
| **阶段二：归档式摘要 + Task State** | 实现事件序号、独立归档、结构化任务状态和引用回溯；压缩只修改发送给模型的上下文视图，不删除原始轨迹。Task State 先走确定性路径（§3.4）；LLM 提炼路径依赖 Phase D 子代理，落地前不阻塞 | 核心层 L4 | 场景：压缩后继续执行 / 跨边界协议完整 / 归档幂等 |
| **阶段三：全量压缩与故障恢复** | 候选摘要校验、压缩事务幂等与原子提交（§7.4）、失败熔断、状态版本管理和中断恢复 + 响应式压缩 | L5 | 场景：无效摘要不覆盖 / 连续失败熔断 / 中断恢复 |
| **阶段四：缓存与成本优化** | 用实际数据调整触发阈值与水位线；比较不同批次大小对 Token 成本、缓存命中和任务成功率的影响；仅当 API 确实支持服务端上下文编辑时，才加入 L3 微压缩适配器 | 数据驱动调优 | §8.3 优化指标全部进入目标带 |

每阶段独立可交付、独立可回归。初始默认值（软 70% / 硬 80% / 阻塞 90% / 批次大小 / gap 60min）
在阶段四按 §8 指标实测校准。

---

## 10. 附录：与 Claude Code 上下文压缩机制的对照

| Claude Code 机制 | Di 本设计的对应物 | 差异 |
|---|---|---|
| L1 上下文窗口：`effectiveCW = CW − 20K − 13K` | §6.1 `B_input` 公式 | 结构一致；Di 以 DeepSeek 1M 窗口按比例缩放 |
| L2 warn/auto/blocking 三级水位线 | §6.2 soft/hard/blocking | 借鉴三级梯度；默认 70/80/90% |
| L2 SM Compact（零 LLM 会话记忆） | §3.4 Task State 双路径（确定性 + LLM 提炼） | Di 把"会话记忆"持久化为 TaskState.json，非仅 .md |
| L2 Legacy Compact + `compact_boundary` | §3.5 L5 + §5.2 边界标记 | 结构同构 |
| L2 Reactive Compact（413 恢复） | §3.5 响应式压缩（溢出错误 → 丢最旧重试，上限 3） | 同构；错误由适配器归一化 |
| L3 Cached MC（`cache_edits`） | §3.3 L3 API 微压缩（可选） | Di 默认跳过（DeepSeek 不支持），本地重建视图兜底 |
| L4 Time-Based MC（gap > 60min） | §3.2 时间触发清理 | 同构 |
| L5 Post-Compact Cleanup | AgentRunner 快照重注入（`_lastSnapshotText` 复位即重注入，§1.1 已实现）+ §4.5 contextVersion | 同构 |
| 微压缩工具白名单 | §3.1 `TOOLS_CLEARABLE_RESULTS` 等价物 | 与 Di 8 工具对齐 |
| 断路器（重试上限 3） | §3.5 连续 3 次熔断 | 对齐 |
| 递归保护（防压缩自身被压缩） | §4.3 | 借鉴 |
| 摘要强制保留清单 + 两阶段提取 | §3.4 压缩指令规范 | 借鉴并落为归档字段约束 |
| 全埋点（`tengu_` 系列） | §8.4 每个压缩动作埋点 + `di --stats` | 同构 |

---

## 11. 关联文档

- `docs/architecture.md` —— 架构快照（模块 `Core.ContextManagement` 落地后同步更新依赖图与数据流）
- `docs/modules/README.md` —— 模块 ↔ 文档 / 源码 / 测试映射（本模块实现后新增一行）
- `docs/modules/agent-loop.md` —— 当前跨回合记忆实现（本文 §1.1 现状即据此核对）
- `docs/roadmap.md` —— 路线图（Phase C 上下文与记忆工程）
- `docs/di-home.md` —— `~/.di` 家目录与分层配置规范（新增配置键时对齐）
- 外部参考：Claude Code 上下文压缩机制深度解析（ForceInjection/AI-fundamentals，
  `08_agentic_system/context/claude-code-context-compression.md`）