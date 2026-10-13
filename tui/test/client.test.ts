/**
 * client 集成测试：用真实 `node` 子进程跑假后端（test/fixtures/fake-rpc-backend.mjs），
 * 验证 ready 握手、prompt 请求 → 事件流 + result、异常退出、优雅关闭，以及二进制解析。
 * 不依赖真实 `di` 后端。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { RpcClient, resolveDiBin } from "../src/rpc/client.ts";
import type { AgentEvent, AgentResult } from "../src/rpc/protocol.ts";

const BACKEND = fileURLToPath(new URL("./fixtures/fake-rpc-backend.mjs", import.meta.url));

function makeClient(overrides: Partial<ConstructorParameters<typeof RpcClient>[0]> = {}): RpcClient {
  return new RpcClient({
    bin: process.execPath,
    args: [BACKEND],
    env: { ...process.env },
    readyTimeoutMs: 5000,
    stopTimeoutMs: 2000,
    ...overrides,
  });
}

describe("RpcClient：ready 握手", () => {
  it("connect 在收到 ready 后 resolve", async () => {
    const client = makeClient();
    await client.connect();
    assert.equal(client.state, "ready");
    await client.stop();
  });

  it("握手前子进程退出 → connect reject 且报错清晰", async () => {
    const client = makeClient({ env: { ...process.env, FAKE_MODE: "exit" } });
    try {
      await assert.rejects(() => client.connect(), /握手前退出/);
    } finally {
      // 断言失败时也要清理子进程，避免测试进程悬挂
      await client.stop();
    }
    assert.equal(client.state, "closed");
  });

  it("ready 前 prompt 被拒绝", async () => {
    const client = makeClient();
    await assert.rejects(() => client.prompt("hi"), /未就绪/);
    // 未连接就 stop：幂等、立即返回
    await client.stop();
    assert.equal(client.state, "closed");
  });
});

describe("RpcClient：prompt 请求", () => {
  it("事件流 + result：onEvent/onResult 回调与返回 promise 都收到", async () => {
    const events: AgentEvent[] = [];
    const results: AgentResult[] = [];
    const client = makeClient({
      onEvent: (e) => events.push(e),
      onResult: (r) => results.push(r),
    });

    await client.connect();
    const result = await client.prompt("hi");

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

    await client.stop();
  });
});

describe("RpcClient：关闭", () => {
  it("stop 发 shutdown → 子进程退出", async () => {
    const client = makeClient();
    await client.connect();
    await client.stop();
    assert.equal(client.state, "closed");
  });
});

describe("resolveDiBin（二进制解析）", () => {
  it("优先使用 DI_BIN", () => {
    assert.equal(resolveDiBin({ DI_BIN: "C:\\tools\\di.exe", PATH: "" }), "C:\\tools\\di.exe");
  });

  it("在 PATH 中找到 di（win32 用 .exe 后缀）", () => {
    const dir = mkdtempSync(join(tmpdir(), "di-path-"));
    const ext = process.platform === "win32" ? ".exe" : "";
    writeFileSync(join(dir, `di${ext}`), "");
    try {
      const found = resolveDiBin({ PATH: dir, HOME: "/nonexistent", USERPROFILE: "/nonexistent" });
      assert.equal(found, join(dir, `di${ext}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("回退到 ~/.di/bin 下的 di", () => {
    const home = mkdtempSync(join(tmpdir(), "di-home-"));
    const binDir = join(home, ".di", "bin");
    mkdirSync(binDir, { recursive: true });
    const ext = process.platform === "win32" ? ".exe" : "";
    writeFileSync(join(binDir, `di${ext}`), "");
    try {
      const found = resolveDiBin({ PATH: "/nonexistent", HOME: home, USERPROFILE: home });
      assert.equal(found, join(binDir, `di${ext}`));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("都找不到 → undefined", () => {
    assert.equal(
      resolveDiBin({ PATH: "/nonexistent/dir", HOME: "/nonexistent", USERPROFILE: "/nonexistent" }),
      undefined,
    );
  });
});
