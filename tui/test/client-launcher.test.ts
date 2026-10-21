/**
 * launcher 注入接缝 + 协议场景测试：通过注入的 TS 后端 launcher
 * （`process.execPath` + 编译后 TS 入口参数，等价于开发期 `node packages/.../index.js --mode rpc`）
 * spawn 场景化假后端（test/fixtures/scenario-backend.mjs），验证：
 * - 注入的 launcher 被实际使用（优先于 bin/args；暴露 client.launcher）。
 * - 流式消费开始 / 排空（跨 chunk 行拆分完整解析；result 后垃圾行不打断下一回合）。
 * - 终态恰好一次（有缺陷后端重复 result 只交付首个）。
 * - busy 行为（回合进行中新 prompt 被拒绝，不覆盖在途回合）。
 * - stdout 协议隔离（stderr 伪协议行不进协议；stdout 垃圾行走 onMalformed）。
 * - 后端异常退出清理（回合中途 / 连接后退出均干净关闭）。
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { RpcClient } from "../src/rpc/client.ts";
import type { AgentEvent, AgentResult } from "../src/rpc/protocol.ts";

const SCENARIO_BACKEND = fileURLToPath(new URL("./fixtures/scenario-backend.mjs", import.meta.url));

function makeScenarioClient(
  overrides: Partial<ConstructorParameters<typeof RpcClient>[0]> = {},
): RpcClient {
  return new RpcClient({
    launcher: { bin: process.execPath, args: [SCENARIO_BACKEND] },
    env: { ...process.env },
    readyTimeoutMs: 5000,
    stopTimeoutMs: 2000,
    ...overrides,
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("RpcClient：TS 后端 launcher 注入接缝", () => {
  it("注入 launcher（process.execPath + TS 入口参数）→ 握手与回合走通", async () => {
    const client = makeScenarioClient();
    await client.connect();
    assert.equal(client.state, "ready");
    const r = await client.prompt("hi");
    assert.equal(r.answer, "result for hi");
    await client.stop();
    assert.equal(client.state, "closed");
  });

  it("client.launcher 反映注入的启动器（bin + args）", () => {
    const launcher = { bin: process.execPath, args: [SCENARIO_BACKEND, "--mode", "rpc"] };
    const client = new RpcClient({ launcher });
    assert.deepEqual(client.launcher, launcher);
    assert.equal(client.binary, process.execPath);
  });

  it("launcher 优先于 bin/args（不按 bin spawn）", async () => {
    const client = new RpcClient({
      bin: "C:\\nonexistent\\di.exe", // 若错误地按 bin spawn，connect 会失败
      args: ["--mode", "rpc"],
      launcher: { bin: process.execPath, args: [SCENARIO_BACKEND] },
      env: { ...process.env },
      readyTimeoutMs: 5000,
      stopTimeoutMs: 2000,
    });
    await client.connect();
    assert.equal(client.state, "ready");
    await client.stop();
  });

  it("launcher 与 bin 均缺失 → 构造抛错", () => {
    assert.throws(() => new RpcClient({}), /launcher/);
  });
});

describe("RpcClient：流式消费与排空", () => {
  it("跨 chunk 行拆分完整解析；result 后垃圾行触发 onMalformed 且下一回合正常（排空）", async (t) => {
    const events: AgentEvent[] = [];
    const malformed: string[] = [];
    const client = makeScenarioClient({
      env: { ...process.env, SCENARIO: "chunked" },
      onEvent: (e) => events.push(e),
      onMalformed: (line) => malformed.push(line),
    });
    t.after(() => client.stop());
    await client.connect();

    const r1 = await client.prompt("one");
    assert.equal(r1.answer, "result for one");
    // 事件全部消费（跨 chunk 拆分不丢行）
    assert.equal(events.length, 2);
    assert.equal(events[0]!.kind, "text_delta");
    assert.equal(events[0]!.delta, "[one] ");
    assert.equal(events[1]!.kind, "turn_completed");
    await waitFor(() => malformed.some((l) => l.includes("trailing non-protocol line")));
    assert.ok(malformed.some((l) => l.includes("trailing non-protocol line")), "垃圾行应触发 onMalformed");

    // 排空：上一回合的残余流不打断下一回合
    const r2 = await client.prompt("two");
    assert.equal(r2.answer, "result for two");

    await client.stop();
  });
});

describe("RpcClient：终态恰好一次", () => {
  it("单 prompt 恰好一个 result（onResult 与返回 promise 各一次）", async () => {
    let onResultCount = 0;
    const client = makeScenarioClient({ onResult: () => onResultCount++ });
    await client.connect();
    const r = await client.prompt("hi");
    assert.equal(r.answer, "result for hi");
    assert.equal(onResultCount, 1);
    await client.stop();
  });

  it("有缺陷后端重复 result 只交付首个", async () => {
    const results: AgentResult[] = [];
    const client = makeScenarioClient({
      env: { ...process.env, SCENARIO: "dup_result" },
      onResult: (r) => results.push(r),
    });
    await client.connect();
    const r = await client.prompt("hi");
    assert.equal(r.answer, "result for hi");
    assert.equal(results.length, 1);
    await client.stop();
  });
});

describe("RpcClient：busy 行为", () => {
  it("回合进行中新 prompt 被拒绝，在途回合仍由自身 result 终结", async () => {
    const client = makeScenarioClient();
    await client.connect();
    const pFirst = client.prompt("first");
    await assert.rejects(() => client.prompt("second"), /尚未终结/);
    // 在途回合不受新 prompt 干扰，仍拿到自己的 result
    const r = await pFirst;
    assert.equal(r.answer, "result for first");
    // 排空后新回合正常
    const r2 = await client.prompt("after");
    assert.equal(r2.answer, "result for after");
    await client.stop();
  });
});

describe("RpcClient：stdout 协议隔离", () => {
  it("stderr 伪协议行不进协议；stdout 垃圾行走 onMalformed 且握手不受影响", async () => {
    const stderrChunks: string[] = [];
    const malformed: string[] = [];
    const client = makeScenarioClient({
      env: { ...process.env, SCENARIO: "stderr_noise" },
      onStderr: (chunk) => stderrChunks.push(chunk),
      onMalformed: (line) => malformed.push(line),
    });

    await client.connect();
    assert.equal(client.state, "ready");
    assert.ok(malformed.some((l) => l.includes("[boot]")), "stdout 垃圾行应触发 onMalformed");
    const stderrGotProto = stderrChunks.some((c) => c.includes("faked-on-stderr"));
    assert.ok(stderrGotProto, "stderr 伪协议行应到 onStderr，不应成为协议消息");

    const r = await client.prompt("hi");
    assert.equal(r.answer, "result for hi");
    await client.stop();
  });
});

describe("RpcClient：后端异常退出清理", () => {
  it("回合中途异常退出 → pending prompt 拒绝、onExit 报退出码、状态关闭、stop 幂等", async () => {
    const exits: Array<[number | null, NodeJS.Signals | null]> = [];
    const client = makeScenarioClient({
      env: { ...process.env, SCENARIO: "exit_mid_turn" },
      onExit: (code, signal) => exits.push([code, signal]),
    });
    await client.connect();

    await assert.rejects(() => client.prompt("hi"), /后端进程退出/);
    await waitFor(() => exits.length === 1);
    assert.equal(exits[0]![0], 3);
    assert.equal(client.state, "closed");

    await client.stop(); // 幂等：异常退出后再 stop 是安全 no-op
    assert.equal(client.state, "closed");
  });

  it("连接后异常退出（无在途回合）→ onExit 触发、状态关闭、stop 幂等", async () => {
    const exits: Array<[number | null, NodeJS.Signals | null]> = [];
    const client = makeScenarioClient({
      env: { ...process.env, SCENARIO: "exit_after_ready" },
      onExit: (code, signal) => exits.push([code, signal]),
    });

    await client.connect();
    await waitFor(() => client.state === "closed");
    assert.equal(exits.length, 1);
    assert.equal(exits[0]![0], 1);

    await client.stop();
    assert.equal(client.state, "closed");
  });
});
