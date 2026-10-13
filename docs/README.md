# Di 文档导航

> **用法**：回答项目源码相关问题时，先在本页定位到具体文档，再按文档中的仓库根相对路径打开源码核实。
> 不要遍历全部 `docs` 或整个代码库。文档编写 / 组织 / 审查规范见 `docs/standards/documentation.md`。

## 顶层文档

跨模块设计文档直接放 `docs/` 根，各自是**唯一权威**（总入口不复制其内容）：

| 文档 | 职责 |
|---|---|
| `docs/architecture.md` | 架构总览：分层 / 依赖方向 / 数据流时序 / 关键设计决策 |
| `docs/cli.md` | CLI 层契约：参数 / 模式 / headless / 换语言重写 |
| `docs/di-home.md` | `~/.di` 家目录与分层配置规范 |
| `docs/tui.md` | TS TUI 设计：分层 / 决策 / 里程碑（M1–M4） |
| `docs/tui-rpc.md` | `--mode rpc` 线协议**唯一权威**（TS TUI ↔ C# 后端） |
| `docs/roadmap.md` | 功能全景 + MVP 缺口 + 工业级路线图 |
| `docs/standards/documentation.md` | 文档编写 / 组织 / 审查规范（按需读） |

## 分类入口

- **核心模块文档** → `docs/modules/README.md`（模块 ↔ 文档 / 源码目录 / 测试目录映射的**唯一权威**，
  默认每个真实命名空间一篇；模块长大时一拆多，见 `docs/standards/documentation.md` §叶子文档的拆分）。

## 快速入口

| 想做什么 | 去读 |
|---|---|
| 了解整体架构 / 依赖方向 / 数据流 / 设计决策 | `docs/architecture.md` |
| 定位某个核心模块 | `docs/modules/README.md` → 对应模块文档 |
| 配置优先级 / 家目录 / 所有权 | `docs/di-home.md` |
| CLI 参数 / headless JSON / 退出码 / 换语言重写 | `docs/cli.md` |
| TS TUI 设计 / RPC 协议契约 | `docs/tui.md` / `docs/tui-rpc.md` |
| 还缺什么 / 下一步做什么 | `docs/roadmap.md` |
| 怎么写文档 / 怎么维护索引 | `docs/standards/documentation.md` |

> 索引树**按需生长**：本文只维护顶层文档与一个分类入口，不枚举每个模块。新增分类 / 专题 /
> 子索引、或保持扁平的判断依据见 `docs/standards/documentation.md` §索引的渐进式扩展。