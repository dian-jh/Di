# Di 家目录与配置规范（~/.di）

> 设计文档。定义 Di 的用户级数据/配置落点与分层合并规则，对齐主流 agent 的约定
> （Claude Code `~/.claude/`、Codex `~/.codex/`），让用户可以直接编写自己的配置、
> skills、命令，而不需要改任何代码。

---

## 1. 定位与原则

- **单一来源**：`~/.di` 是 Di 唯一的用户级数据根目录，由 `Core.Configuration.DiHome` 统一解析，
  各子系统不再各自拼路径。
- **所有权分明**：程序只写 `sessions/`（会话记录）；配置文件（`config.json` 等）一律**用户所有**，
  程序只读、不创建、不覆盖。
- **分层覆盖**：配置按「默认 → 用户全局 → 项目级 → 环境变量」合并，后一层覆盖前一层，
  全部灌进同一个 `IConfiguration`，各 Options 绑定自动生效。
- **目录即契约**：子目录的**位置**现在是规范，其内容（skills/commands/agents/MCP）按目录约定
  逐步实现，将来加功能时目录结构不需要再改。

## 2. 目录结构

```
~/.di/
├── config.json            # 用户全局配置（可选；用户自己写，程序只读）
├── sessions/              # 会话记录（SessionLog 写入，追加式 JSONL）
│   └── YYYY/MM/DD/
│       └── session-*.jsonl
├── skills/                # 用户 skills（将来）
│   └── <name>/SKILL.md
├── commands/              # 用户斜杠命令（将来）
│   └── <name>.md
├── agents/                # 子代理定义（将来）
│   └── <name>.md
└── mcp.json               # MCP 服务器配置（将来，JSON 数组）
```

根目录可被环境变量 `DI_HOME` 覆盖（测试隔离、多环境共存）：

```bash
export DI_HOME=~/mydi    # 默认是 ~/.di
```

### 2.1 各条目职责

| 条目 | 谁写 | 谁读 | 状态 |
|---|---|---|---|
| `config.json` | 用户 | 程序（分层配置源 #2） | ✅ 已实现（用户级） |
| `sessions/YYYY/MM/DD/*.jsonl` | 程序（SessionLog） | 用户/重放工具 | ✅ 已实现 |
| `skills/<name>/SKILL.md` | 用户 | SkillRepository（`/skill` 激活） | ✅ MVP |
| `commands/<name>.md` | 用户 | 将来命令注册表 | 🔜 格式已预留 |
| `agents/<name>.md` | 用户 | 将来子代理加载器 | 🔜 格式已预留 |
| `mcp.json` | 用户 | 将来 MCP 桥 | 🔜 格式已预留 |

## 3. 配置分层与优先级

程序启动时由 `Di.Cli.DiConfig.Load(workspace, homeRoot)` 依次加载以下源，**后加载覆盖先加载**：

| 优先级 | 源 | 位置 | 说明 |
|---|---|---|---|
| 1（最低） | 程序默认值 | 各 Options 类的属性默认值 | 兜底 |
| 2 | 构建内默认 | `appsettings.json`（随 exe 走） | 随发行版走的出厂默认 |
| 3 | 用户全局 | `~/.di/config.json` | 个人偏好 |
| 4 | 项目级 | `<workspace>/.di/config.json` | 团队共享，随仓库走 |
| 5（最高） | 环境变量 | 进程环境 | 运行时覆盖（如 `Model__DefaultModel`） |

> **项目级 > 用户全局**：与 Claude Code 的 local > project > user 一致——仓库内的团队设置
> 优先于个人偏好（例如团队统一默认模型，个人只覆盖 UI 偏好）。

### 3.1 配置段

| 段 | 绑定到 | 主要键 |
|---|---|---|
| `AgentLoop` | `AgentLoopOptions` | `SystemPrompt`、`MaxIterations` |
| `Model` | `ModelOptions` | `Provider`、`DefaultModel` |
| `Repl` | `ReplOptions` | `Prompt`、`HelpText`、`WorkingStatusText`、`UseAnsi` |
| `Retry` | `RetryPolicyOptions` | `MaxAttempts`、`InitialBackoff` 等 |
| `DeepSeek` | `DeepSeekAdapterConfig` | `ApiKey`、`BaseUrl`、`DefaultReasoningEffort`、`StrictTools` |

示例——用户个人配置 `~/.di/config.json`：

```json
{
  "Model": { "DefaultModel": "deepseek-v4-pro" },
  "Repl": { "Prompt": "di> " }
}
```

项目级 `<workspace>/.di/config.json`（团队统一）：

```json
{
  "AgentLoop": { "MaxIterations": 12 },
  "DeepSeek": { "DefaultReasoningEffort": "max" }
}
```

环境变量覆盖（键名用 `__` 代替 `:` 分层）：

```bash
export Model__DefaultModel=deepseek-flash
```

## 4. 所有权规则

- **程序写**：`sessions/`（会话记录，追加式 JSONL，进程中断不损坏）；`~/.di` 根目录本身
  在首次写会话时隐式创建。
- **程序只读**：`config.json`、`skills/`、`commands/`、`agents/`、`mcp.json`。
- 程序**绝不**覆盖已存在的配置文件；也不因「配置文件缺失」而报错——所有配置源都是可选的。

## 5. 实现现状

| 能力 | 落点 | 状态 |
|---|---|---|
| 家目录解析（`DI_HOME` + `~/.di` 默认） | `Core/Configuration/DiHome.cs` | ✅ |
| 分层配置合并（4 源） | `Di.Cli/DiConfig.cs` | ✅ |
| 配置段绑定 | `Di.Cli/DiServiceCollectionExtensions.cs` | ✅ |
| SessionLog 不再写 `config.json` | `Core/Sessions/SessionLog.cs` | ✅ |
| 组合根决策入配置（prompt/迭代上限/默认模型/UI） | `Di.Cli/Program.cs` | ✅ |
| Skills：MS 规范解析 + 两级发现 + 激活注入 | `Core/Skills/` + `Di.Cli/Repl.cs` | ✅ |
| Skills：渐进式披露（广告块 + `load_skill` 工具） | `Core/Skills/SkillTools.cs` + `AgentRunner` | ✅ |
| Skills：匹配器质量与上下文成本指标 | `Core/Skills/SkillEvaluator.cs` | ✅ |

## 6. 将来扩展（格式预留给定）

- **commands**：`commands/<name>.md`，把 `Repl.RunCommand` 的 if/else 换成从该目录加载的注册表。
- **MCP**：`mcp.json` 声明服务器（stdio 命令 + 环境），通过 `ICoreTool`/`IToolProvider` 桥接，
  ReAct 循环无感。
- **项目级指令**：将来支持 `<workspace>/AGENTS.md` 作为项目指令注入（当前
  `CoreTools.Instructions` 是代码内默认，可被 `AgentLoop:SystemPrompt` 覆盖）。

## 7. Skill 测试与指标

对每个重要 skill 建议三类测试：

| 类别 | 例子 | 验收目标 |
|---|---|---|
| 触发测试 | 用户提出符合 skill 用途的任务 | 正确选中该 skill |
| 排除测试 | 用户提出相似但不适用的任务 | 不误触发 |
| 执行测试 | 提供真实输入并运行完整工作流 | 结果符合预定义验收条件 |

自动匹配的质量指标由 `Core/Skills/SkillEvaluator.cs` 在带标签用例集
（`SkillTestCase(Message, ExpectedSkills)`）上统计，触发/排除测试即对应的标签用例：

- **精确率** = 激活且应激活 ÷ 激活：被选中的 skill 里有多少确实该选。
- **召回率** = 激活且应激活 ÷ 应激活：该选的 skill 里有多少被选中。
- **无匹配率** = 未激活任何 skill 的用例占比（排除测试的反面）。
- **上下文成本** = 每回合 skill 相关平均估算 token：`SkillContext.EstimateTokens`
  （广告块 + 激活 skill 完整指令，约 4 字符/token）——衡量渐进式披露是否真的省了上下文。

执行测试超出匹配器范围：按 skill 的实际工作流（调工具跑通）单独做集成验证。
示例 skill：`examples/skills/backend-tests/SKILL.md`。
