# di-tui — Di 终端界面（TypeScript 前端）

生产 CLI 通过本地 `RunnerPort` adapter 调用 `runInteractive`。独立启动本包时，通过子进程
与 TypeScript 后端的 `--mode rpc` 交换 NDJSON。协议见
[`docs/tui-rpc.md`](../docs/tui-rpc.md)，组件与端口边界见 [`docs/tui.md`](../docs/tui.md)。

## 环境要求

- Node.js ≥ 22.19（npm 包 `@earendil-works/pi-tui` 的 engines 要求）
- 已构建或安装的 `@di/coding-agent` 后端

## 构建 / 运行

```bash
npm ci                  # 仓库根目录安装锁定依赖
npm run build           # 构建全部 workspace（包含后端）
npm start -w di-tui      # 启动独立 RPC TUI
```

测试（无需真实终端 / 真实后端）：

```bash
npm test -w di-tui
```

## 如何找到 di

`src/rpc/backend-launcher.ts` 的 `buildBackendLauncher` 按以下顺序选择启动器：

1. 环境变量 `DI_BIN`（显式指定，优先级最高）
2. 工作区的 `packages/coding-agent/dist/cli/main.js`
3. 安装在同级 `node_modules` 下的 `@di/coding-agent/dist/cli/main.js`

示例：

```bash
DI_BIN="/path/to/rpc-backend" npm start -w di-tui
```

TypeScript 入口通过当前 Node 可执行文件启动；显式 `DI_BIN` 会直接接收 `--mode rpc` 参数。
若没有可用入口，启动报错并返回退出码 1。

## 使用

- 输入提示词后按 Enter 提交，开始一回合；助手文本 / 工具调用会流式渲染。
- `Ctrl+C`：运行中首按发送 `interrupt` 取消当前回合（`stop_reason: "cancelled"`），再次按发送
  `shutdown` 优雅退出；空闲时首按即退出。

## 结构

```
src/
├── main.ts           # 独立入口：选择 TypeScript 后端并通过 RPC 启动
├── interactive.ts    # 共用 TUI 生命周期：terminal、视图、输入与退出
├── runner/
│   ├── port.ts       # 同进程与 RPC runner 共用的接口
│   └── rpc-port.ts   # RpcClient 到 RunnerPort 的适配
├── rpc/
│   ├── protocol.ts   # 协议类型定义（与 docs/tui-rpc.md 逐字段对应）
│   ├── codec.ts      # NDJSON 编解码：行帧、parse+validate、FIFO 队列、编码
│   └── client.ts     # 子进程管理：spawn、ready 握手、请求方法、事件订阅、退出清理
└── app/
    ├── state.ts      # 回合状态机（idle/running/cancelling）与视图模型
    ├── chat-view.ts  # 聊天视口：transcript + 状态行 + 提示输入
    ├── message.ts    # 用户 / 助手消息组件（流式追加）
    ├── tool-call.ts  # 工具调用组件（标题行 + 结果）
    ├── commands.ts   # 命令解析
    ├── terminal-mode.ts # terminal 初始化与清理
    ├── chat-layout.ts   # 聊天视图布局
    ├── badge.ts / rule.ts # 状态徽标与分隔线
    ├── colors.ts / spacing.ts # 样式与间距辅助
    └── fold-navigation.ts # 折叠内容导航
test/                 # node --test 单元 / 集成测试（不依赖终端）
```

验证事实及尚未完成的发布门槛见 [`docs/typescript-validation.md`](../docs/typescript-validation.md)。
