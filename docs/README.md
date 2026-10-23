# Di 文档导航

项目源码相关问题按“本索引 → 对应文档 → 文档所列源码”查阅。文档规范见
[`docs/standards/documentation.md`](standards/documentation.md)。

| 文档 | 内容 |
|---|---|
| [`architecture.md`](architecture.md) | TypeScript workspace 架构与数据流 |
| [`cli.md`](cli.md) | CLI 参数、运行模式与恢复行为 |
| [`di-home.md`](di-home.md) | `~/.di`、配置与数据目录 |
| [`interrupt.md`](interrupt.md) | 回合软停止、取消与退出 |
| [`tui.md`](tui.md) / [`tui-rpc.md`](tui-rpc.md) | TUI 结构与 RPC wire 协议 |
| [`context-compression.md`](context-compression.md) | 上下文预算与压缩 |
| [`roadmap.md`](roadmap.md) | 功能范围与后续工作 |
| [`modules/README.md`](modules/README.md) | 模块职责及源码入口 |
| [`typescript-validation.md`](typescript-validation.md) | 当前验证证据与未完成的发布门槛 |

常用入口：整体调用关系看 `architecture.md`；CLI 看 `cli.md`；认证、工具、会话、事件和模型看
`modules/README.md`。源码路径均相对仓库根目录。
