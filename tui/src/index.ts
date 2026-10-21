/**
 * di-tui（当前 `tui/` workspace）公共入口：只导出 runner 接缝与 wire-shape
 * 契约，绝不导入 @di/agent / @di/coding-agent。`tui/src/main.ts` 只作旧 RPC
 * launcher（外部子进程路径），不是本包的 import 入口。
 *
 * 导出：
 * - {@link runInteractive}(port) —— 把 RunnerPort 接入现有 TUI 组件树；
 * - {@link RunnerPort} / {@link RunnerPortHandlers} / {@link RunnerCommandResult}
 *   —— 宿主实现的 runner 操作面（wire 载荷即 protocol.ts 类型）；
 * - {@link RpcClientPort} —— 子进程 RPC 客户端的 RunnerPort 适配；
 * - {@link CommandError} —— runCommand 的命令级错误（turn_not_supported 载荷）。
 */

export { runInteractive } from "./interactive.ts";
export type { InteractiveOptions } from "./interactive.ts";

export { RpcClientPort } from "./runner/rpc-port.ts";
export type { RpcClientPortOptions } from "./runner/rpc-port.ts";

export type {
  RpcAgentEvent,
  RpcAgentResult,
  RpcCommandDescriptor,
  RpcReadyMessage,
  RunnerCommandResult,
  RunnerPort,
  RunnerPortHandlers,
} from "./runner/port.ts";

export { CommandError } from "./rpc/client.ts";
