/**
 * runInteractive 接线测试（无真实终端，只测可在无 TTY 环境确定的契约）：
 * - connect 前必须先订阅 handlers（architecture.md §RunnerPort 生命周期顺序）；
 * - connect 失败 → runInteractive 抛错（不进入可输入状态），并注销已注册 handlers。
 * runInteractive 只在 port 完成 ready 握手后才构建 terminal/view（失败路径零渲染）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runInteractive } from "../src/interactive.ts";
import type {
  RpcAgentResult,
  RpcCommandDescriptor,
  RpcReadyMessage,
  RunnerCommandResult,
  RunnerPort,
  RunnerPortHandlers,
} from "../src/runner/port.ts";

/** 记录调用顺序的假 port：connect 校验 subscribe 必须先于 connect，可注入失败。 */
class RecordingPort implements RunnerPort {
  calls: string[] = [];
  handlers: RunnerPortHandlers | null = null;
  /** 在通过订阅顺序校验后立即抛错（避免推进到 terminal 构建）。 */
  failAfterOrdering = false;

  subscribe(handlers: RunnerPortHandlers): () => void {
    this.calls.push("subscribe");
    this.handlers = handlers;
    return () => {
      this.calls.push("unsubscribe");
      if (this.handlers === handlers) this.handlers = null;
    };
  }

  async connect(): Promise<void> {
    this.calls.push("connect");
    if (this.handlers === null) throw new Error("subscribe must precede connect");
    if (this.failAfterOrdering) throw new Error("boom");
    this.handlers.onReady({ type: "ready", version: "0.0.0-test", model: "fake" });
  }

  async prompt(_message: string): Promise<RpcAgentResult> {
    this.calls.push("prompt");
    return { answer: "", stop_reason: "answer", iterations: 0, usage: { input_tokens: 0, output_tokens: 0 } };
  }

  interrupt(): void {
    this.calls.push("interrupt");
  }

  clearHistory(): void {
    this.calls.push("clearHistory");
  }

  setModel(_model: string): void {
    this.calls.push("setModel");
  }

  setSkills(_names: string[]): void {
    this.calls.push("setSkills");
  }

  async listCommands(): Promise<RpcCommandDescriptor[]> {
    this.calls.push("listCommands");
    return [];
  }

  async runCommand(_name: string, _args?: string): Promise<RunnerCommandResult> {
    this.calls.push("runCommand");
    return { lines: [], exit: false };
  }

  ping(): void {
    this.calls.push("ping");
  }

  async stop(): Promise<void> {
    this.calls.push("stop");
  }
}

describe("runInteractive 接线顺序", () => {
  it("subscribe 先于 connect：runInteractive 先注册 handlers 再握手", async () => {
    const port = new RecordingPort();
    port.failAfterOrdering = true; // 校验订阅顺序后抛错，阻止推进到 terminal 构建
    await assert.rejects(() => runInteractive(port), /boom/);
    // 订阅发生在 connect 之前（假 port 的 connect 在未订阅时抛 "subscribe must precede connect"，
    // 这里收到的是 "boom" 即证明顺序正确）。
    assert.deepEqual(port.calls.slice(0, 2), ["subscribe", "connect"]);
    assert.ok(port.calls.includes("unsubscribe"), "runInteractive 退出时注销 handlers");
  });

  it("connect 失败 → runInteractive 抛同一错误并注销 handlers", async () => {
    const port = new RecordingPort();
    port.failAfterOrdering = true;
    await assert.rejects(() => runInteractive(port), /boom/);
    assert.equal(port.handlers, null, "handlers 已被注销（不进入可输入状态）");
  });
});
