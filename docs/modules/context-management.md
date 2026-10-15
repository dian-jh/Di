# Core.ContextManagement —— 上下文压缩系统

> 模块文档。回答"上下文预算怎么算、L1 工具结果预算控制怎么落地、水位线如何触发"。
> 顶层设计（全部五层机制 / 触发时机 / 持久化布局）：`docs/context-compression.md`（唯一权威）。
> 上一级入口：`docs/README.md`。

## 目的与职责

管理模型上下文预算，防止长会话因输入膨胀超窗：

- **`BudgetPolicy`**：输入预算公式（§6.1）+ 多级水位线（§6.2）+ 预测性触发判定（§6.3），纯逻辑无 IO；
- **`CompactingExecutor`**：L1 工具结果预算控制（§3.1）——包装 `IToolExecutor`，白名单工具的大输出
  落盘 artifacts + 摘要进上下文；
- **`ArtifactStore` / `IArtifactStore`**：L1 大输出落盘（§7.1 artifacts/ 布局）；
- **`ContextManagementOptions`**：模块配置（`ContextManagement` 配置段，分层配置见 `docs/di-home.md`）。

阶段一（本模块当前范围）只落地 **L1 + BudgetPolicy**；L2 噪声删除 / L4 归档 + Task State /
L5 全量压缩与响应式恢复随阶段二 / 三上线（都定义在顶层设计，见 §9 分阶段落地）。

## 实现原理

### L1 执行缝（不改 ReAct）

工具结果预算控制在"执行后、进轨迹前"拦截。现有缝是 `IToolExecutor` 包装层——
`SkillAwareExecutor`（`Core/Skills/SkillTools.cs`）示范了"把执行器包一层"的模式，L1 复用同一缝：
组合根（`Di.Cli/CliHost.cs`）把生产执行器用 `CompactingExecutor` 包一层，`ReAct` 全程无感知。

```
AgentRunner ── IToolExecutor ──► [SkillAwareExecutor?] ──► CompactingExecutor ──► CoreTools.Executor
                                   （skills 存在时由 AgentRunner 包）          （L1 拦截点）
```

工具调用协议（tool_use / tool_result 配对）不受影响：装饰器只改**观察文本的表示**
（完整 ↔ 摘要 + artifactRef），不增删调用或结果消息，请求仍被 provider 接受（§8.2 跨边界协议完整）。

### 预算公式（§6.1）

```
B_input = B_window − B_output − B_margin
```

- `B_window`：模型目录的 `ModelSpec.ContextWindow`（组合根经 `ILlmService.ResolveModelAsync` 解析）；
- `B_output`：给模型输出/压缩摘要输出预留（默认 20_000 token）；
- `B_margin`：估算误差 / 动态提示 / 工具定义的安全空间，**默认窗口的 10%，随窗口缩放**。
  窗口小于预留（`B_window ≤ B_output + B_margin`）时 `B_input` 归零（不为负）。

### 多级水位线（§6.2，相对 B_input 的比例，随窗口缩放）

| 水位线 | 默认比例 | 触发条件 | 阶段一动作 |
|---|---|---|---|
| soft（软阈值） | 70% | `inputs ≥ SoftRatio × B_input` | L1 预算控制（结果摘要化 + 落盘） |
| hard（硬阈值） | 80% | 同上 | （L2/L4 随阶段二上线） |
| blocking（阻塞线） | 90% | 同上 | （强制压缩 / 缩小任务范围，随阶段二/三） |

### 预测性触发（§6.3）

```
B_predicted = B_current + B_next-tool-estimate + B_next-output-reserve
```

L1 控制点正在"执行后、进轨迹前"：`B_next-tool-estimate` 用结果的**实际长度**
（`TokenEstimator` ~4 字符/token）测得，无需执行前预测；`B_predicted ≥` soft 水位线 → 该结果
改用摘要 + 落盘，而不是先把大输出灌进上下文再压。`B_current`（本回合累计输入 token）经构造参数
注入（默认 0）；**把跨回合累计（由 AgentRunner 维护）接进 L1 是下一步**（见下节"下一步"）。

### L1 落盘与摘要（§3.1）

- **可清理白名单**（§3.1，借鉴 Claude Code `TOOLS_CLEARABLE_RESULTS`）：Di 8 个内置工具中
  `read_file / grep / glob / 平台 shell 工具 / powershell / python`——纯检索 / 执行产物，丢中间
  不影响协议。shell 工具同时匹配 `CoreTools.PlatformShellName`（Windows 为 "cmd"）与内部注册键
  "bash"（Windows 兼容别名），两者路由同一实例。`edit_file / write_file` **不在白名单，永不落盘改写**。
- **摘要**：确定性截断（不调 LLM）——头部 + `…[省略中间 N 字符]…` + 尾部（复用 `OutputBuffer`
  头 6000 / 尾 18000 字符口径）+ 开头一行 artifactRef 引用（完整落盘路径，模型可用 read_file 读取）。
- **fail-safe**：落盘或摘要任一步失败 → 回退完整文本进上下文，**绝不打断回合**。
- **缓存一致性**：本层只影响"进轨迹前"的表示选择；已入上下文的完整结果不做原地改写
  （复核压缩走 L4 整轮归档，阶段二，§3.1）。

### 持久化（§7.1，阶段一子集）

```
~/.di/sessions/YYYY/MM/DD/artifacts/tool-<工具>-<时间戳>-<序号>.txt
```

根目录经 `DiHome` 解析（`DI_HOME` 可覆盖）。**阶段一尚无"每会话目录"**（`<session>/` 子目录随
阶段二迁入，见顶层设计 §7.1 边界说明），artifacts 先按天落盘。

## 代码入口

| 文件（相对仓库根） | 职责 |
|---|---|
| `Core/ContextManagement/BudgetPolicy.cs` | 预算公式 + 三级水位线 + B_predicted（纯逻辑） |
| `Core/ContextManagement/CompactingExecutor.cs` | L1：包装 IToolExecutor，白名单大输出落盘 + 摘要 |
| `Core/ContextManagement/ArtifactStore.cs` / `IArtifactStore.cs` | L1 落盘（sessions/YYYY/MM/DD/artifacts/），可注入假存储 |
| `Core/ContextManagement/ContextManagementOptions.cs` | 配置段 `ContextManagement`（Enabled、MarginRatio、OutputReserveTokens、NextOutputReserveTokens、SoftRatio、HardRatio、BlockingRatio） |
| `Di.Cli/CliHost.cs` | 组合根：默认模型窗口解析成功且 Enabled → 包一层 CompactingExecutor；失败回退原行为 |
| `Di.Cli/DiServiceCollectionExtensions.cs` | `AddOptions<ContextManagementOptions>().BindConfiguration("ContextManagement")` |

## 关键符号

- `BudgetPolicy`（构造参数自带默认：margin 10% 窗口 / output 20k / soft 70% / hard 80% / blocking 90%）：
  `InputBudget`、`SoftThreshold` / `HardThreshold` / `BlockingThreshold`、`WaterlineFor`、
  `static Predict`、`PredictsOverSoft`
- `Waterline`（`Under` / `Soft` / `Hard` / `Blocking`）
- `CompactingExecutor`（`IToolExecutor`，构造注入 `(inner, policy, artifacts, currentInputTokens?)`）
- `IArtifactStore.Write(toolName, content) → path`、`ArtifactStore.ArtifactsDirectory`
- `ContextManagementOptions`

## 调用关系

```
Di.Cli/CliHost.cs（组合根）
  ├─ IOptions<ContextManagementOptions>：Enabled？窗口解析成功？
  │    是 → CompactingExecutor(CoreTools.Executor, BudgetPolicy(窗口…), ArtifactStore(DiHome 根))
  │    否 → 原执行器（回退原行为）
  └─ AgentRunner(…, toolExecutor, …)        ← ReAct 无感知
        └─ ReAct.ExecuteToolAsync ──► IToolExecutor（CompactingExecutor 拦截）
              ├─ 白名单 + B_predicted ≥ soft → Write(artifacts) + 摘要（fail-safe）
              └─ 其余 → 原样观察文本
```

依赖方向：`Di.Cli → Core.ContextManagement → Core.AgentLoop(IToolExecutor) / Core.Llm(TokenEstimator) /
Core.Tools(CoreTools / OutputBuffer)`；持久化经 `DiHome`（Core.Configuration）解析根目录。

## 已实现能力与测试

| 能力 | 落点 | 测试 |
|---|---|---|
| B_input 公式（含窗口小于预留归零、margin 归零） | `BudgetPolicy` | `Di.Tests/ContextManagement/BudgetPolicyTests.cs` |
| 三级水位线数学（含比例 clamp、序校验、边界归类） | `BudgetPolicy` | `Di.Tests/ContextManagement/BudgetPolicyTests.cs` |
| B_predicted 预测判定（含策略默认 next-output-reserve） | `BudgetPolicy` | `Di.Tests/ContextManagement/BudgetPolicyTests.cs` |
| L1：小输出直通 / 大输出白名单落盘 + 摘要 | `CompactingExecutor` | `Di.Tests/ContextManagement/CompactingExecutorTests.cs` |
| L1：edit_file / write_file / 非白名单永不落盘 | `CompactingExecutor` | `Di.Tests/ContextManagement/CompactingExecutorTests.cs` |
| L1：落盘失败 fail-safe 回退完整文本 | `CompactingExecutor` | `Di.Tests/ContextManagement/CompactingExecutorTests.cs` |
| L1：B_current 累计参与预测 / shell 平台名 + bash 别名 | `CompactingExecutor` | `Di.Tests/ContextManagement/CompactingExecutorTests.cs` |
| 落盘布局与文件往返（真实文件系统） | `ArtifactStore` | `Di.Tests/ContextManagement/ArtifactStoreTests.cs` |

## 关联文档

- `docs/context-compression.md` —— 顶层设计（五层机制 / 预算 / 持久化 / 分阶段落地，唯一权威）
- `docs/modules/agent-loop.md` —— 跨回合记忆现状（每轮丢最旧；预算化改造是下一步）
- `docs/di-home.md` —— `~/.di` 家目录与分层配置（`ContextManagement` 配置段）
- `docs/architecture.md` —— 依赖方向与数据流（本模块已登记）
- `docs/roadmap.md` —— Phase C 上下文与记忆工程

## 下一步（阶段一的自然延伸）

1. **AgentRunner 预算化改造**：把"每轮丢最旧整回合"（`TrimHistory` / `TrimHistoryByTokens`）升级为
   按 `BudgetPolicy` 水位线触发；同时把跨回合累计的 `B_current` 经注入接入 `CompactingExecutor` 的
   预测判定——阶段一默认 0，长会话靠当下结果长度单点触发的场景依赖这一步。
2. **L4 归档 + Task State**（阶段二）：事件序号、逐轮独立归档、执行事件落盘与引用回溯；
   对"已入上下文的大结果"的复核压缩走整组归档，不原地改写。
3. **L2 噪声删除 / L5 全量压缩与响应式恢复 / L3 微压缩**（阶段二 / 三 / 四）。