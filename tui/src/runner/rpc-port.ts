/**
 * RpcClientPort：把现有子进程 RPC 客户端（`tui/src/rpc/client.ts` 的
 * {@link RpcClient}）适配到 {@link RunnerPort} 接口。
 *
 * 生命周期（architecture.md §RunnerPort）：`subscribe(handlers)` 在 connect 前
 * 缓存 handler；`connect()` 创建并启动底层 RpcClient 时把 handlers 绑定到
 * `RpcClientOptions` 回调，ready 回调原样调用 onReady 后让 connect resolve。
 * 两种实现（RpcClientPort / LocalAgentRunnerAdapter）都不得在订阅前发 ready/event。
 *
 * `tui/src/main.ts` 解析后端启动器、创建 RpcClientPort，并调用
 * `runInteractive(rpcPort)`，作为独立运行 TUI 的入口。
 */

import type { RpcAgentResult, RunnerCommandResult, RunnerPort, RunnerPortHandlers } from "./port.ts";
import { CommandError, RpcClient, type Launcher } from "../rpc/client.ts";
import type { CommandDescriptor, ModelInfo } from "../rpc/protocol.ts";

/** RpcClientPort 构造选项：透传 {@link RpcClientOptions} 中与回调无关的部分。 */
export interface RpcClientPortOptions {
  /** 后端启动器（完整 spawn 描述）；提供时优先于 bin/args。 */
  launcher?: Launcher;
  /** di 可执行文件路径（launcher 未提供时的后备）。 */
  bin?: string;
  /** 附加参数，默认 ["--mode", "rpc"]（launcher 未提供时生效）。 */
  args?: string[];
  /** 进程环境变量（默认 process.env）。 */
  env?: NodeJS.ProcessEnv;
  /** 等待 `ready` 的超时（默认 5000ms）。 */
  readyTimeoutMs?: number;
  /** 发 `shutdown` 后等待退出的超时（默认 2000ms）。 */
  stopTimeoutMs?: number;
}

export class RpcClientPort implements RunnerPort {
  private readonly options: RpcClientPortOptions;
  private handlers: RunnerPortHandlers | null = null;
  private client: RpcClient | null = null;

  constructor(options: RpcClientPortOptions = {}) {
    this.options = options;
  }

  subscribe(handlers: RunnerPortHandlers): () => void {
    this.handlers = handlers;
    return () => {
      if (this.handlers === handlers) this.handlers = null;
    };
  }

  /**
   * spawn 后端进程并等待 `ready` 握手（handlers 在 connect 前已注册，回调直达）。
   * 失败时 reject（不进入可输入状态），onError/onExit 仍按现有 client 语义触发。
   */
  async connect(): Promise<void> {
    const handlers = this.handlers;
    const client = new RpcClient({
      launcher: this.options.launcher,
      bin: this.options.bin,
      args: this.options.args,
      env: this.options.env,
      readyTimeoutMs: this.options.readyTimeoutMs,
      stopTimeoutMs: this.options.stopTimeoutMs,
      onReady: (meta) => handlers?.onReady(meta),
      onEvent: (event) => handlers?.onEvent(event),
      onResult: (result) => handlers?.onResult(result),
      onError: (message, code) => handlers?.onError(message, code),
      onExit: (code, signal) => handlers?.onExit?.(code, signal),
      onStderr: (chunk) => handlers?.onStderr?.(chunk),
      onMalformed: (line, error) => handlers?.onMalformed?.(line, error),
    });
    this.client = client;
    await client.connect();
  }

  prompt(message: string): Promise<RpcAgentResult> {
    return this.requireClient().prompt(message);
  }

  interrupt(): void {
    this.client?.interrupt();
  }

  clearHistory(): void {
    this.client?.clearHistory();
  }

  setModel(model: string): void {
    this.client?.setModel(model);
  }

  setSkills(names: string[]): void {
    this.client?.setSkills(names);
  }

  listCommands(): Promise<CommandDescriptor[]> {
    return this.requireClient().listCommands();
  }

  runCommand(name: string, args = ""): Promise<RunnerCommandResult> {
    // RpcClient.runCommand 对 command_error 抛 CommandError（含 turn_not_supported）；
    // 原样透传给调用方（TUI 的 runCommand 处理器按其 code/turnMessage 接续）。
    return this.requireClient().runCommand(name, args);
  }

  ping(): void {
    this.client?.ping();
  }

  /** 发 shutdown 等子进程退出（幂等）；未连接/已关闭时立即返回。 */
  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client !== null) await client.stop();
  }

  private requireClient(): RpcClient {
    if (this.client === null) {
      throw new Error("RunnerPort 未连接（尚未 connect 或已 stop）");
    }
    return this.client;
  }
}
