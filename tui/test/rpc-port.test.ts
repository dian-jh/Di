/**
 * RpcClientPort（runner 接缝）集成测试：用真实 `node` 子进程跑假后端
 * （test/fixtures/fake-rpc-backend.mjs），验证 subscribe→connect 顺序、ready
 * 握手经 handlers 送达、prompt 事件流 + result、命令应答/回合型命令错误、
 * 优雅关闭与幂等。与 client.test.ts 同源行为，经 RunnerPort 接口。
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { RpcClientPort } from "../src/runner/rpc-port.ts";
import { CommandError } from "../src/rpc/client.ts";
import type { AgentEvent, AgentResult, ReadyMessage, RunnerPortHandlers } from "../src/runner/port.ts";

const BACKEND = fileURLToPath(new URL("./fixtures/fake-rpc-backend.mjs", import.meta.url));

function makePort(overrides: { env?: NodeJS.ProcessEnv } = {}): RpcClientPort {
  return new RpcClientPort({ bin: process.execPath, args: [BACKEND], env: overrides.env ?? { ...process.env } });
}

/** Subscribe and capture callbacks (mirrors what runInteractive wires). */
function subscribe(port: RpcClientPort): {
  ready: ReadyMessage[];
  events: AgentEvent[];
  results: AgentResult[];
  errors: { message: string; code: string }[];
  unsub: () => void;
} {
  const ready: ReadyMessage[] = [];
  const events: AgentEvent[] = [];
  const results: AgentResult[] = [];
  const errors: { message: string; code: string }[] = [];
  const handlers: RunnerPortHandlers = {
    onReady: (meta) => ready.push(meta),
    onEvent: (event) => events.push(event),
    onResult: (result) => results.push(result),
    onError: (message, code) => errors.push({ message, code }),
  };
  const unsub = port.subscribe(handlers);
  return { ready, events, results, errors, unsub };
}

describe("RpcClientPort：connect 握手", () => {
  it("subscribe 在前，connect resolve 且 onReady 收到富化元数据", async () => {
    const port = makePort();
    const { ready } = subscribe(port);
    await port.connect();
    assert.equal(port["client"]?.state, "ready");
    assert.equal(ready.length, 1);
    assert.equal(ready[0]!.model, "deepseek-flash");
    assert.equal(ready[0]!.effort, "high");
    assert.equal(ready[0]!.skills?.[0]?.name, "backend-tests");
    assert.equal(ready[0]!.models?.length, 2);
    await port.stop();
  });

  it("握手前子进程退出 → connect reject 且错误清晰", async () => {
    const port = makePort({ env: { ...process.env, FAKE_MODE: "exit" } });
    subscribe(port);
    await assert.rejects(() => port.connect(), /握手前退出/);
    await port.stop();
  });
});

describe("RpcClientPort：prompt 请求", () => {
  it("事件流 + result：onEvent/onResult 回调与返回 promise 都收到", async () => {
    const port = makePort();
    const { events, results } = subscribe(port);
    await port.connect();

    const result = await port.prompt("hi");

    assert.equal(result.answer, "Hello from fake. Done.");
    assert.equal(result.stop_reason, "answer");
    assert.equal(result.cost, 0.001);
    assert.equal(events.length, 7);
    assert.equal(events[0]!.kind, "text_delta");
    assert.equal(events[1]!.kind, "tool_call_delta");
    assert.equal(events[4]!.kind, "tool_completed");
    assert.equal(events[6]!.kind, "turn_completed");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.answer, "Hello from fake. Done.");

    await port.stop();
  });
});

describe("RpcClientPort：命令系统", () => {
  it("listCommands 返回注册表（CommandDescriptor 形状）", async () => {
    const port = makePort();
    subscribe(port);
    await port.connect();
    const commands = await port.listCommands();
    assert.equal(commands.length, 2);
    assert.equal(commands[0]?.name, "model");
    assert.equal(commands[0]?.argument_hint, "<模型名>");
    await port.stop();
  });

  it("runCommand 返回输出行与模型快照", async () => {
    const port = makePort();
    subscribe(port);
    await port.connect();
    const result = await port.runCommand("model", "chatgpt/account-model");
    assert.equal(result.model, "chatgpt/account-model");
    assert.equal(result.effort, null);
    assert.deepEqual(result.models, [{ id: "chatgpt/account-model", name: "Account model" }]);
    await port.stop();
  });

  it("runCommand 回合型命令抛 CommandError turn_not_supported 且带 turnMessage", async () => {
    const port = makePort();
    subscribe(port);
    await port.connect();
    await assert.rejects(
      () => port.runCommand("skill", "backend-tests 补测试"),
      (err: unknown) => {
        assert.ok(err instanceof CommandError, `期望 CommandError，实际 ${err}`);
        assert.equal((err as CommandError).code, "turn_not_supported");
        assert.match((err as CommandError).turnMessage ?? "", /【Skill：backend-tests】/);
        return true;
      },
    );
    await port.stop();
  });

  it("runCommand exit 命令返回 exit=true", async () => {
    const port = makePort();
    subscribe(port);
    await port.connect();
    const result = await port.runCommand("exit");
    assert.equal(result.exit, true);
    await port.stop();
  });
});

describe("RpcClientPort：关闭", () => {
  it("stop 发 shutdown → 子进程退出；可重复调用幂等", async () => {
    const port = makePort();
    subscribe(port);
    await port.connect();
    await port.stop();
    assert.equal(port["client"], null);
    await port.stop(); // 幂等
  });
});
