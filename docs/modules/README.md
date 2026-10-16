# 核心模块文档索引

> 本目录按**真实命名空间**组织核心模块文档。每篇聚焦一个模块：目的、实现原理、源码入口
> （相对仓库根路径）、关键符号、调用关系、已实现能力与测试、关联文档。
> 上层总入口：`docs/README.md`；跨模块依赖与数据流见 `docs/architecture.md`。

## 模块一览（唯一权威表）

下表是**模块 ↔ 文档 / 源码目录 / 测试目录 / 职责一句话**映射的唯一权威。其它文档不得复制
本表，如有需要只用链接或一句话摘要。

| 模块（命名空间） | 文档 | 源码目录（相对仓库根） | 测试目录 | 职责一句话 |
|---|---|---|---|---|
| Common.Events | `events.md` | `Common/Events/` | `Di.Tests/Events/` | 进程内事件总线：ReAct 只发事件不渲染，CLI 拉流渲染 |
| Core.AgentLoop | `agent-loop.md` | `Core/AgentLoop/` | `Di.Tests/AgentLoop/` | ReAct 循环 + 跨回合宿主（历史 / 快照 / skills） |
| Core.ContextManagement | `context-management.md` | `Core/ContextManagement/` | `Di.Tests/ContextManagement/` | 上下文压缩：BudgetPolicy 预算/水位线 + L1 工具结果预算控制（大输出落盘 + 摘要） |
| Core.Llm | `llm.md` | `Core/Llm/` | `Di.Tests/Llm/` | 模型层抽象：路由 / 流式协议 / 重试 / 计量 / 成本 / 目录 / 认证 |
| Core.Providers.DeepSeek | `deepseek.md` | `Core/Providers/DeepSeek/` | `Di.Tests/Providers/` | DeepSeek 适配器：厂商怪癖唯一居所 |
| Core.Providers.ChatGpt | `chatgpt.md` | `Core/Providers/ChatGpt/` | `Di.Tests/Providers/` | 官方 OAuth、Responses、缓存计量与模型切换 |
| Core.Tools | `tools.md` | `Core/Tools/` | `Di.Tests/Tools/` | 8 个内置编码工具 + 注册表 + 执行器 |
| Core.Skills | `skills.md` | `Core/Skills/` | `Di.Tests/Skills/` | SKILL.md 解析 / 发现合并 / 词法匹配 / 渐进式披露 / 评估 |
| Core.Sessions | `sessions.md` | `Core/Sessions/` | `Di.Tests/Sessions/` | 会话 JSONL 落盘（对齐 codex 格式） |
| Core.Logging | `logging.md` | `Core/Logging/` | `Di.Tests/Logging/` | 运行日志（jcode 格式，~/.di/logs 按日一个文件，EventBus 旁路订阅） |

> `Core.Configuration`（家目录单一来源 / 分层配置）没有独立模块文档，其规范统一维护在顶层设计
> 文档 `../di-home.md`。Common / Core 其它基础设施目录如无专门文档，则不在此列出。

## 跨模块依赖与数据流

依赖方向与一次回合的数据流时序**唯一定义在 `docs/architecture.md`**，此处不再复制依赖树。
各模块文档在各自的「调用关系」节给出局部视角。

## 顶层跨切面文档

`docs/` 根直接放置跨模块设计文档（`docs/architecture.md` / `docs/cli.md` / `docs/di-home.md` /
`docs/interrupt.md` / `docs/tui.md` / `docs/tui-rpc.md` / `docs/roadmap.md`），
详见 `docs/README.md` 顶层一览表。

## 索引的渐进式扩展

- 当前 8 篇模块文档 + 1 张唯一权威表，导航前置**保持扁平**，尚不需要子分类。
- 将来模块 / 专题增多时再拆分（进入子分类 `docs/modules/<分类>/README.md`），触发与改造规则见
  `docs/standards/documentation.md` §索引的渐进式扩展。
- 单个模块文档长大到需一拆多时（如 `tools.md`），该命名空间退化为子目录
  `docs/modules/<模块>/`（子 README + 多篇），**本权威表仍只占一行**、指向其子 README——
  规则见 `docs/standards/documentation.md` §叶子文档的拆分。
