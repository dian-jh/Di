/**
 * P7b-1 TUI 接线：后端启动器纯函数（buildBackendLauncher）测试。
 *
 * 钉死回退顺序（行为可观察）：
 *   1. `DI_BIN` 显式指定 → bin 即 DI_BIN（用户显式覆盖，最高优先级）。
 *   2. TS 编译入口存在 → `process.execPath` + [entry, "--mode", "rpc"]（TS 后端为默认，
 *      且优先于旧 C# 二进制回退；不是 di.exe / .cmd shim）。
 *   3. entry 缺失 + 无 DI_BIN + PATH / ~/.di/bin 有 di → resolveDiBin 回退（旧 C# 二进制）。
 *   4. 三者皆缺 → `{ kind: "unavailable" }`，main 据此报错并 exit 1。
 *
 * 纯函数：注入 existsFn / env，零真实 fs IO 也可测（实现默认 node:fs existsSync 注入）。
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";

import { buildBackendLauncher, resolveTsEntryPath } from "../src/rpc/backend-launcher.ts";

const TS_ENTRY = resolveTsEntryPath();

const isWin = process.platform === "win32";
/** 假 PATH 目录 + 旧 C# 二进制候选（win32 上为 di.exe；posix 为 di）。 */
const FAKE_DIR = path.join(isWin ? "C:\\" : "/", "__tui_backend_launcher_test__", "bin");
const LEGACY_DI = path.join(FAKE_DIR, isWin ? "di.exe" : "di");

/** 构造不含 DI_BIN 的测试 env（清除宿主 DI_BIN，避免外部环境干扰；overrides 显式设置的 DI_BIN 保留）。 */
function envWithoutDiBin(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  if (!overrides.DI_BIN) delete env.DI_BIN;
  return env;
}

/** existsFn：只有给定候选存在。 */
function onlyExists(...candidates: string[]): (p: string) => boolean {
  const set = new Set(candidates);
  return (p) => set.has(p);
}

describe("buildBackendLauncher：回退顺序", () => {
  it("TS 编译入口存在（无 DI_BIN，PATH 上也有旧 di）→ node + entry + --mode rpc，TS 后端优先于 legacy", () => {
    const env = envWithoutDiBin({ PATH: FAKE_DIR });
    const decision = buildBackendLauncher(env, onlyExists(TS_ENTRY, LEGACY_DI));
    assert.equal(decision.kind, "launcher");
    if (decision.kind !== "launcher") return;
    // TS 后端：bin 是 node（process.execPath），不是 C# di.exe / .cmd shim。
    assert.equal(decision.launcher.bin, process.execPath);
    assert.deepEqual(decision.launcher.args, [TS_ENTRY, "--mode", "rpc"]);
  });

  it("resolveTsEntryPath：默认相对 monorepo 布局，绝对路径指向编译后 TS CLI 入口", () => {
    assert.ok(path.isAbsolute(TS_ENTRY), `entry 应为绝对路径: ${TS_ENTRY}`);
    const normalized = TS_ENTRY.replaceAll("\\", "/");
    assert.ok(
      normalized.endsWith("packages/coding-agent/dist/cli/index.js"),
      `entry 应指向 packages/coding-agent/dist/cli/index.js，实际: ${TS_ENTRY}`,
    );
  });

  it("DI_BIN 显式指定 → bin 即 DI_BIN（最高优先级，即使 TS 入口存在）", () => {
    const DI_BIN = "C:\\custom\\di.exe";
    const env = envWithoutDiBin({ DI_BIN, PATH: FAKE_DIR });
    const decision = buildBackendLauncher(env, onlyExists(TS_ENTRY, LEGACY_DI));
    assert.equal(decision.kind, "launcher");
    if (decision.kind !== "launcher") return;
    assert.equal(decision.launcher.bin, DI_BIN);
    assert.deepEqual(decision.launcher.args, ["--mode", "rpc"]);
  });

  it("entry 缺失 + DI_BIN 设置 → bin 即 DI_BIN", () => {
    const DI_BIN = "C:\\custom\\di.exe";
    const env = envWithoutDiBin({ DI_BIN });
    const decision = buildBackendLauncher(env, () => false);
    assert.equal(decision.kind, "launcher");
    if (decision.kind !== "launcher") return;
    assert.equal(decision.launcher.bin, DI_BIN);
    assert.deepEqual(decision.launcher.args, ["--mode", "rpc"]);
  });

  it("entry 缺失 + 无 DI_BIN + PATH 上有旧 di → resolveDiBin 回退（legacy bin + --mode rpc）", () => {
    const env = envWithoutDiBin({ PATH: FAKE_DIR });
    const decision = buildBackendLauncher(env, onlyExists(LEGACY_DI));
    assert.equal(decision.kind, "launcher");
    if (decision.kind !== "launcher") return;
    assert.equal(decision.launcher.bin, LEGACY_DI);
    assert.deepEqual(decision.launcher.args, ["--mode", "rpc"]);
  });

  it("entry 缺失 + 无 DI_BIN + PATH/~/.di/bin 无 di → unavailable（main 据此报错 exit 1）", () => {
    const env = envWithoutDiBin({ PATH: FAKE_DIR });
    const decision = buildBackendLauncher(env, () => false);
    assert.equal(decision.kind, "unavailable");
  });
});
