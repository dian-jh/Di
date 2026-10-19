# TypeScript Core 迁移执行手册

> **状态：设计与执行计划，尚未实施。** 本目录供后续 AI 迁移 Core；目标源码、测试和脚本都是待创建产物，不代表仓库已经支持这些命令。当前功能文档继续描述 C# 实现。

## 基线与范围

| 项目 | 固定值 / 约束 |
|---|---|
| Di 行为基线 | `09f4e08`，原分支 `feature/loop` |
| 本次文档分支 | `migration/typescript-core`，从上述提交创建；原分支保留 |
| Pi 只读参考 | 本地 `E:\Agent\PI\pi`；提交 `7f9e1198f2f7a8cf5ea18d5010ba081d4d60c333` |
| 本轮交付 | 给其他 AI 执行的迁移文档；不改运行代码、安装版和真实用户数据 |
| 后续实施 | C# Core / Common / 必要 CLI 宿主迁为 TS；保留现有 `tui/` 组件及交互 |
| 完成定义 | 两个 provider、工具、Skills、预算、恢复、CLI 和安装契约经过验收，不能以“能聊天”代替 |

Pi 检出路径仅便于查阅，不能出现在产品导入、安装脚本或运行配置中。异机执行应查同一提交；参考模块与采用理由见架构文档。Pi 为 MIT，复制源码需履行许可证义务，不能把“参考架构”当作已经授权搬入任意依赖。

基线跟踪文件的物理行数（含注释 / 空行，不含构建生成物）：C# 生产 122 文件 / 12,548 行，C# 测试 70 文件 / 15,698 行；TS 生产 15 文件 / 2,519 行，TS 测试 12 文件 / 1,435 行。这不是未来必须保持的代码量或测试数量。

## 阅读顺序与唯一职责

| 顺序 | 文档 | 职责 |
|---|---|---|
| 1 | [docs/migration/typescript-core/architecture.md](architecture.md) | 包边界、模块映射、共用接口、Pi 借鉴决策 |
| 2 | [docs/migration/typescript-core/execution-plan.md](execution-plan.md) | 阶段任务与依赖、Skills / 配置 / 命令 / 日志、交接要求 |
| 3 | [docs/migration/typescript-core/loop-and-state.md](loop-and-state.md) | 循环、历史、预算、取消、事件、宿主状态 |
| 4 | [docs/migration/typescript-core/models-and-auth.md](models-and-auth.md) | 消息与模型流、两个 provider、用量、重试、认证 |
| 5 | [docs/migration/typescript-core/tools-and-platform.md](tools-and-platform.md) | 八个工具、shell、编码、进程、平台差异 |
| 6 | [docs/migration/typescript-core/sessions-and-compatibility.md](sessions-and-compatibility.md) | JSONL / checkpoint、恢复、跨语言与外部输出兼容 |
| 7 | [docs/migration/typescript-core/validation-and-release.md](validation-and-release.md) | 测试矩阵、差分验证、CI、发布、切换和回退 |

当前实现入口：[docs/modules/README.md](../../modules/README.md)、[docs/cli.md](../../cli.md)、[docs/tui-rpc.md](../../tui-rpc.md)。现状与设计冲突时先核对 `09f4e08` 的源码，区分必须兼容的外部行为和需要单独修复的旧缺陷。

## 执行 AI 必须保持的边界

1. 保留 C# 行为参考，不在旧分支迁移，不删除难迁移测试来获得通过。
2. TUI 首先通过原 RPC 接 TS 后端，再增加同进程 Runner 适配；不重写组件、布局、键位或主题。
3. 首期只建 `@di/ai`、`@di/agent`、`@di/coding-agent` 加现有 `tui/`。完整模块映射只在架构文档维护，不复制 Pi 所有包。
4. 每单元先写业务失败测试并运行确认 red，再实现最小逻辑到 green；副作用、协议失败和取消不能只测 happy path。
5. 内部 TS 类型与外部 JSON codec 分开，不能依赖 `JSON.stringify()` 自动保留 C# 字段和枚举。
6. intent 成功写入后才执行工具；已启动但结果未知不能自动重放；不承诺任意外部工具的 exactly-once。
7. 不借迁移新增自动摘要、MCP、子代理、权限系统、插件体系或新 provider；当前 `ContextLimit` 是保留轨迹后暂停。
8. 测试使用独立 `DI_HOME`、临时工作区和合成凭据；不读取真实 token、不转换真实日志、不回放用户副作用。

## 工具链与命令状态

既有 `tui/package-lock.json` 已核实锁定 TypeScript `5.9.3`、`@types/node` `22.20.5`、`@earendil-works/pi-tui` `1.2.0`。首期沿用这些版本并固定直接依赖；升级另行提交。最低 Node 沿用 `22.19`，本机为 `24.16.0`；最低版本支持仍需 CI 实测。

当前可运行的基线命令（假设依赖已还原 / 安装）：

```powershell
dotnet test Di.slnx --no-restore --filter "Category!=Integration" --verbosity minimal
npm.cmd --prefix tui test
npm.cmd --prefix tui run build
```

不要意外运行真实 API 集成测试。未来根 workspaces、`test:unit` / `test:compat` / `test:process` 等脚本须先按计划创建，不能把文档中的未来命令报告为已执行或通过。

## 判断歧义

- **现状事实**引用 Di 仓库相对源码与关键符号；需要时用 `git show 09f4e08:<path>`。
- **未来路径和接口**始终标为规划；本轮未创建。
- **旧缺陷**用明确输入、预期和回归测试记录；不能默默改协议、丢功能或降低安全边界。
- **未决定细节**在对应最小任务内核实并记录，不以“待定”冒充已实现。

接手 AI 的第一个动作是 [execution-plan.md 的 P0](execution-plan.md#p0-冻结参考与行为清单)，不是删除 `.cs` 或复制整个 Pi。
