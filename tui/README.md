# di-tui — Di 终端界面（TypeScript 前端）

TS TUI 作为 `di --mode rpc`（C# 后端）的前端，通过子进程 + NDJSON over stdin/stdout 协议驱动
harness 核心。协议唯一权威：[`docs/tui-rpc.md`](../docs/tui-rpc.md)；设计与里程碑见
[`docs/tui.md`](../docs/tui.md)。UI 与核心互不认识对方代码，只认协议。

## 环境要求

- Node.js ≥ 22.19（npm 包 `@earendil-works/pi-tui` 的 engines 要求）
- 可用的 `di` 二进制（见下文"如何找到 di"）

## 构建 / 运行

```bash
cd tui
npm install      # 安装依赖（首次）
npm run build    # tsc 编译到 dist/
npm start        # node dist/main.js 启动 TUI
```

测试（无需真实终端 / 真实后端）：

```bash
npm test         # node --test test/*.test.ts
```

## 如何找到 di

启动时按以下顺序解析 `di` 可执行文件路径：

1. 环境变量 `DI_BIN`（显式指定，优先级最高）
2. PATH 上的 `di`（win32 上会尝试 `di`、`di.exe`、`di.cmd`、`di.bat`）
3. `~/.di/bin/di.exe`（win32；其他平台为 `~/.di/bin/di`）

示例：

```bash
DI_BIN="C:\path\to\di.exe" npm start
```

若都找不到，启动会报错并退出码 1。若找到的 `di` 是旧版本（不支持 `--mode rpc`），后端进程会在
握手前退出，TUI 会打印清晰的错误说明——需要先升级到支持 RPC 的版本。

## 使用

- 输入提示词后按 Enter 提交，开始一回合；助手文本 / 工具调用会流式渲染。
- `Ctrl+C`：运行中首按发送 `interrupt` 取消当前回合（`stop_reason: "cancelled"`），再次按发送
  `shutdown` 优雅退出；空闲时首按即退出。

## 结构

```
src/
├── main.ts           # 入口：解析 di → spawn --mode rpc → 装配视图 → 事件循环
├── rpc/
│   ├── protocol.ts   # 协议类型定义（与 docs/tui-rpc.md 逐字段对应）
│   ├── codec.ts      # NDJSON 编解码：行帧、parse+validate、FIFO 队列、编码
│   └── client.ts     # 子进程管理：spawn、ready 握手、请求方法、事件订阅、退出清理
└── app/
    ├── state.ts      # 回合状态机（idle/running/cancelling）+ 视图模型
    ├── chat-view.ts  # 聊天视口：transcript + 状态行 + 提示输入
    ├── message.ts    # 用户 / 助手消息组件（流式追加）
    └── tool-call.ts  # 工具调用组件（标题行 + 结果）
test/                 # node --test 单元 / 集成测试（不依赖终端）
```

## 里程碑状态

M1（本目录）：C# RPC 后端 + TS TUI MVP（inline 聊天：流式文本、工具行、提示输入、Ctrl+C 中断）。
M2+ 计划见 `docs/tui.md` §5（全屏视口、工具折叠、Markdown 主题等）。
