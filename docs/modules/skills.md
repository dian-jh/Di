# Core.Skills —— Skills（渐进式披露的指令工作流）

> 模块文档。回答"SKILL.md 怎么写、怎么被发现合并、怎么自动匹配、渐进式披露怎么省上下文、怎么评估匹配器"。
> 上一级入口：`docs/README.md`；目录约定见 `docs/di-home.md`；激活与注入见 `docs/modules/agent-loop.md`。

## 目的与职责

按需加载的**指令工作流**：用户把可复用的操作流程写成 `SKILL.md`（frontmatter 元数据 + 指令正文），
harness 在回合前按消息语义**自动匹配**激活，未激活的只**广告**名字，模型需要时用 `load_skill` 工具
按名加载完整指令——**渐进式披露**，避免把全部正文常驻上下文（对齐 MS Agent Framework 的 Advertise 阶段）。

## 实现原理

### SKILL.md 解析（`Core/Skills/SkillMarkdown.cs`）

`---` 包裹的 YAML frontmatter + 正文指令。字段对齐 MS Agent Framework：`name` / `description` 必需，
`metadata`（嵌套缩进键值）、`allowed-tools`（空格分隔）、`license` / `compatibility` 可选；
另有对齐 Pi 的 `disable-model-invocation: true|false`（true → 只接受显式 `/skill` 调用，
不进广告块、不进自动匹配）。
严格性：受识别字段必须小写且只能出现一次（重复 → 拒绝）；`name` 必须匹配父目录名 / 文件基名；
非法格式拒绝；未知顶层字段忽略（向前兼容）。MVP 只解析单行 / 单层缩进的 `key: value`。

### 两级发现合并（`Core/Skills/SkillRepository.cs`）

两种发现规则：目录式 `<root>/<name>/SKILL.md`（MS 规范）与扁平式 `<root>/<name>.md`
（对齐 Pi 的 `.pi/skills/*.md` 惯例，单文件 skill 无需建目录）。同一来源内目录式先加载、
扁平式后加载，同源同名扁平覆盖目录式（顺序确定性）。来源：用户级（`~/.di/skills`）+
项目级（`<workspace>/.di/skills`），**项目级覆盖同名用户级**（与配置分层同一心智：具体环境优先）。
无效 skill（解析失败 / 读盘失败）跳过并回调 `warn`，绝不让启动失败。

### 词法自动匹配（`Core/Skills/SkillMatcher.cs`）

`ISkillMatcher`（**可替换接缝**）+ `LexicalSkillMatcher`：把用户消息与每个 skill 的 name+description
分词（ASCII 单词 + 中文二元组），用**重叠系数**（重叠 token ÷ 较短一方的 token 数）算相关度——
长查询与长描述都不被稀释（查询覆盖率以完整查询长度为分母，口语化长消息的填充词会把它稀释到阈值以下
导致漏匹配）；低于 `MinRelevance`（0.30）过滤、超过 `MaxMatches`（3）截断。
`disable-model-invocation` 的 skill 不参与自动匹配。轻量、离线、确定性、可测试；
中英混杂的转述匹配弱于 embedding（那是升级路径，换实现即可）。

### 渐进式披露（`Core/Skills/SkillContext.cs` + `Core/Skills/SkillTools.cs`）

- 未激活 skill 只注入一行 `name：description`（广告块，约 100 token/skill）；
  已激活 skill（固定 `/skill` + 每回合自动匹配）注入完整指令。
- `load_skill` 工具（`Core/Skills/SkillTools.cs`）按名加载完整指令；`SkillAwareExecutor` 装饰器拦截该调用，
  其余委托内层执行器。

### 匹配评估（`Core/Skills/SkillEvaluator.cs`）

在带标签用例集（`SkillTestCase(Message, ExpectedSkills)`）上统计精确率 / 召回率 / 无匹配率 /
平均上下文 token（触发 / 排除测试即标签用例）。

## 组件清单（全部在 `Core/Skills/`）

| 组件 | 代码（相对仓库根） | 职责 |
|---|---|---|
| Skill 模型 | `Core/Skills/Skill.cs` | record：name / description / Instructions / Metadata / AllowedTools / DisableModelInvocation |
| SKILL.md 解析 | `Core/Skills/SkillMarkdown.cs` | frontmatter 解析 + 严格校验（含 `disable-model-invocation`）；`SkillFormatException` |
| 发现合并 | `Core/Skills/SkillRepository.cs` | 两级发现合并（目录式 + 扁平式），无效跳过只告警 |
| 词法自动匹配 | `Core/Skills/SkillMatcher.cs` | `ISkillMatcher` + `LexicalSkillMatcher`（重叠系数，跳过被禁用项） |
| 匹配评估 | `Core/Skills/SkillEvaluator.cs` | 精确率 / 召回率 / 无匹配率 / 上下文成本 |
| 上下文渲染 | `Core/Skills/SkillContext.cs` | 广告块渲染 + token 成本估算 |
| load_skill 工具 | `Core/Skills/SkillTools.cs` | `load_skill` 定义 + `SkillAwareExecutor` 装饰器 |

## 关键符号

- `Skill`（含 `DisableModelInvocation`）、`SkillFormatException`
- `SkillRepository.Load(userDirectory, projectDirectory, warn)`（目录式 `<name>/SKILL.md` + 扁平式 `<name>.md`）
- `ISkillMatcher` / `LexicalSkillMatcher`（`MinRelevance` / `MaxMatches` / 重叠系数）
- `SkillContext.BuildAdvertisement` / `EstimateTokens`
- `SkillTools.LoadSkillTool` / `ExecuteLoadSkill` / `SkillAwareExecutor`
- `SkillEvaluator.Evaluate` / `SkillTestCase` / `SkillMetrics`
- 注入侧：`AgentRunner.ActiveSkills`（`Core/AgentLoop/AgentRunner.cs`）、`Repl`（`Di.Cli/Repl.cs`）

## 流动路径（装配到注入）

```
Di.Cli/CliHost.cs
  └─ SkillRepository.Load(diHome.SkillsDirectory, <workspace>/.di/skills)   ← 发现合并，无效只告警
        ↓ skills 传入 AgentRunner（构造参数）
Core/AgentLoop/AgentRunner.cs
  ├─ 构造：有 skill 时 _tools 追加 SkillTools.LoadSkillTool，
  │        执行器包一层 SkillAwareExecutor（拦截 load_skill，其余委托）
  └─ RunAsync：按 ActiveSkills 构建 SystemContext（放请求末尾，不进持久历史）
      ├─ 已激活 skill（固定 /skill + 每回合自动匹配）→ 完整指令注入
      └─ 未激活 skill → 广告块（可用 skills 清单，供模型按需 load_skill）
        ↓
Core/Skills/SkillTools.cs（SkillAwareExecutor）← 模型调 load_skill 时拦截，返回完整指令或 error 观察
```

每回合自动匹配发生在 `Di.Cli/Repl.cs`（`_matcher.Match(userMessage, _skills)`，剔除已固定 `/skill` 的），
结果写入 `AgentRunner.ActiveSkills`（固定 + 自动匹配逐回合注入）。

## 测试与指标

对每个重要 skill 建议三类测试：

| 类别 | 例子 | 验收目标 |
|---|---|---|
| 触发测试 | 用户提出符合 skill 用途的任务 | 正确选中该 skill |
| 排除测试 | 用户提出相似但不适用的任务 | 不误触发 |
| 执行测试 | 提供真实输入并运行完整工作流 | 结果符合预定义验收条件 |

自动匹配的质量指标由 `SkillEvaluator` 在带标签用例集上统计（触发 / 排除测试即对应的标签用例）：

- **精确率** = 激活且应激活 ÷ 激活：被选中的 skill 里有多少确实该选。
- **召回率** = 激活且应激活 ÷ 应激活：该选的 skill 里有多少被选中。
- **无匹配率** = 未激活任何 skill 的用例占比（排除测试的反面）。
- **上下文成本** = 每回合 skill 相关平均估算 token（`SkillContext.EstimateTokens`，广告块 + 激活完整指令，
  约 4 字符/token）——衡量渐进式披露是否真的省了上下文。

执行测试超出匹配器范围：按 skill 的实际工作流（调工具跑通）单独做集成验证。
示例 skill：`examples/skills/backend-tests/SKILL.md`。

## 已实现能力与测试

| 能力 | 落点 | 测试 |
|---|---|---|
| SKILL.md 解析（严格校验） | `SkillMarkdown` | `Di.Tests/Skills/SkillMarkdownTests.cs` |
| 两级发现合并 | `SkillRepository` | `Di.Tests/Skills/SkillRepositoryTests.cs` |
| 词法自动匹配 | `LexicalSkillMatcher` | `Di.Tests/Skills/SkillMatcherTests.cs` |
| 渐进式披露（广告 + load_skill） | `SkillContext` + `SkillTools` | `Di.Tests/Skills/SkillToolsTests.cs` |
| 匹配质量评估 | `SkillEvaluator` | `Di.Tests/Skills/SkillEvaluatorTests.cs` |
| 固定激活 `/skill` | `Di.Cli/Repl.cs`（`ActivateSkill`） | `Di.Cli.Tests/ReplTests.cs` |

## 关联文档

- `docs/di-home.md` —— `~/.di/skills/<name>/SKILL.md` 目录约定与所有权
- `docs/modules/agent-loop.md` —— 注入侧（`AgentRunner.ActiveSkills` / SystemContext 布局）
- `docs/roadmap.md` —— embedding 语义匹配（扩展缝，Phase 无关）、allowed-tools 语义（待权限层）
