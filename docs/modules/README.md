# 核心模块文档索引

> 本目录按**真实命名空间**组织核心模块文档。每篇聚焦一个模块：目的、实现原理、源码入口
> （相对仓库根路径）、关键符号、调用关系、已实现能力与测试、关联文档。
> 上层总入口：`docs/README.md`；跨模块依赖与数据流见 `docs/architecture.md`。

## 模块一览（唯一权威表）

下表是**模块 ↔ 文档 / 源码目录 / 测试目录 / 职责一句话**映射的唯一权威。其它文档不得复制
本表，如有需要只用链接或一句话摘要。

| 模块（命名空间） | 文档 | 源码目录（相对仓库根） | 测试目录 | 职责一句话 |
|---|---|---|---|---|
| Common.Events | `events.md` | `Common/Events/`; `packages/coding-agent/src/core/events/`; `packages/agent/src/types.ts` | `Di.Tests/Events/`; `packages/agent/test/agent-loop.test.ts` | 进程内事件总线：循环发事件，宿主和前端订阅渲染 |
| Core.AgentLoop | `agent-loop.md` | `Core/AgentLoop/`; `packages/agent/src/`; `packages/coding-agent/src/core/agent-session.ts` | `Di.Tests/AgentLoop/`; `packages/agent/test/`; `packages/coding-agent/test/agent-session.test.ts` | ReAct 循环 + 跨回合宿主（历史 / 快照 / skills） |
| Core.ContextManagement | `context-management.md` | `Core/ContextManagement/`; `packages/coding-agent/src/core/context-management.ts` | `Di.Tests/ContextManagement/`; `packages/coding-agent/test/cli/context-budget.test.ts` | 上下文压缩：预算/水位线 + L1 工具结果落盘与摘要 |
| Core.Llm | `llm.md` | `Core/Llm/`; `packages/ai/src/` | `Di.Tests/Llm/`; `packages/ai/test/` | 模型层抽象：流式协议 / 重试 / 计量 / 成本 / 目录 |
| Core.Providers.DeepSeek | `deepseek.md` | `Core/Providers/DeepSeek/`; `packages/ai/src/providers/deepseek/` | `Di.Tests/Providers/`; `packages/ai/test/` | DeepSeek 适配器：厂商线格式翻译与传输 |
| Core.Providers.ChatGpt | `chatgpt.md` | `Core/Providers/ChatGpt/`; `packages/ai/src/providers/chatgpt/`; `packages/coding-agent/src/core/auth/` | `Di.Tests/Providers/`; `packages/ai/test/`; `packages/coding-agent/test/auth/` | ChatGPT Responses 适配器与宿主 OAuth 凭据组件 |
| Core.Tools | `tools.md` | `Core/Tools/`; `packages/coding-agent/src/core/tools/` | `Di.Tests/Tools/`; `packages/coding-agent/test/tools/` | 内置编码工具、注册表、进程与共享会话执行器 |
| Core.Skills | `skills.md` | `Core/Skills/`; `packages/coding-agent/src/core/skills/` | `Di.Tests/Skills/`; `packages/coding-agent/test/skills/` | SKILL.md 解析 / 发现合并 / 词法匹配 / 渐进式披露 / 评估 |
| Core.Sessions | `sessions.md` | `Core/Sessions/`; `packages/coding-agent/src/core/sessions/` | `Di.Tests/Sessions/`; `packages/coding-agent/test/`; `packages/coding-agent/test/fixtures/sessions/` | 会话 JSONL、checkpoint、恢复与统计 |
| Core.Logging | `logging.md` | `Core/Logging/`; `packages/coding-agent/src/core/logging/` | `Di.Tests/Logging/`; `packages/coding-agent/test/logging/` | 运行日志与进程诊断 |

> `Core.Configuration`（家目录单一来源 / 分层配置）没有独立模块文档，其规范统一维护在顶层设计
> 文档 `../di-home.md`；TS 对应实现位于 `packages/coding-agent/src/core/config/`。Common / Core 其它基础设施目录如无专门文档，则不在此列出。C# 路径是迁移参考实现，TS 路径是当前实现入口；阶段缺口以迁移进度表为准。

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
