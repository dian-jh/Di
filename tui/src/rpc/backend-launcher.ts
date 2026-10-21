/**
 * 后端启动器决策（P7b-1 TUI 接线）：从进程环境 + 文件存在性，纯函数地决策
 * RpcClient 该用哪个 launcher spawn 后端（行为被 backend-launcher.test.ts 钉死）。
 *
 * 回退顺序：
 *   1. `DI_BIN` 显式指定 → 直接用它（用户显式覆盖，最高优先级）。
 *   2. TS 编译入口存在 → `process.execPath` + [entry, "--mode", "rpc"]
 *      （TS 后端为默认；Windows npm `.cmd` shim 不可当原生 exe spawn，
 *       故用 node 可执行文件加编译后入口参数，见 execution-plan §P7）。
 *   3. resolveDiBin 回退（PATH 上的 `di` / `~/.di/bin`）→ 旧 C# 二进制。
 *   三者皆缺 → `{ kind: "unavailable" }`，main 据此报错并 exit 1。
 *
 * 纯函数：所有 fs 存在性检查走注入的 existsFn（默认 node:fs existsSync），
 * env 注入默认 process.env，单测零真实 IO。
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Launcher } from "./client.ts";

/** 后端来源（unavailable 时给出哪些后备缺失）。 */
export type BackendSource = "di-bin" | "ts-entry" | "legacy-bin";

/** 决策结果：可用 launcher，或三源皆缺的缺省信号（main 据此报错 exit 1）。 */
export type BackendLaunchDecision =
  | { kind: "launcher"; launcher: Launcher }
  | { kind: "unavailable"; missing: BackendSource[] };

/** `--mode rpc` 是 RPC 模式唯一启动参数（launcher 未提供时 client 的默认也一致）。 */
const RPC_ARGS = ["--mode", "rpc"];

/**
 * 编译后 TS CLI 入口默认路径：相对 monorepo 布局（tui/src/rpc → 仓库根 →
 * packages/coding-agent/dist/cli/main.js）。源码（src/rpc）与编译产物
 * （dist/rpc）两种布局下同一公式都成立。入口名与 package.json
 * `bin["di-ts"]` 一致（architecture.md §7 / §141-147，P9）。
 */
export function resolveTsEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // <repo>/tui/{src|dist}/rpc
  return path.resolve(here, "..", "..", "..", "packages", "coding-agent", "dist", "cli", "main.js");
}

/**
 * resolveDiBin 的纯函数版本（client.ts 原版保持导出不动）：用注入 existsFn
 * 替代真实 fs 存在性检查，逻辑与 client.ts 一致（DI_BIN → PATH → ~/.di/bin）。
 */
function resolveLegacyBin(
  env: NodeJS.ProcessEnv,
  existsFn: (p: string) => boolean,
): string | undefined {
  const isWin = process.platform === "win32";
  const exts = isWin ? ["", ".exe", ".cmd", ".bat"] : [""];
  const pathVar = env.PATH ?? "";
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `di${ext}`);
      if (existsFn(candidate)) return candidate;
    }
  }
  const home = env.USERPROFILE ?? env.HOME;
  if (home) {
    const candidate = path.join(home, ".di", "bin", isWin ? "di.exe" : "di");
    if (existsFn(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 决策后端启动器（纯函数）。
 * @param env 进程环境（默认 process.env）。
 * @param existsFn 文件存在性检查（默认 node:fs existsSync；单测注入假实现零 IO）。
 */
export function buildBackendLauncher(
  env: NodeJS.ProcessEnv = process.env,
  existsFn: (p: string) => boolean = existsSync,
): BackendLaunchDecision {
  // 1. DI_BIN 显式指定：用户显式覆盖优先于 TS 默认与旧二进制回退。
  if (env.DI_BIN) {
    return { kind: "launcher", launcher: { bin: env.DI_BIN, args: RPC_ARGS } };
  }
  // 2. TS 编译入口存在：node + 编译后入口（TS 后端为默认）。
  const entry = resolveTsEntryPath();
  if (existsFn(entry)) {
    return {
      kind: "launcher",
      launcher: { bin: process.execPath, args: [entry, "--mode", "rpc"] },
    };
  }
  // 3. resolveDiBin 回退：PATH / ~/.di/bin 上的旧 C# 二进制。
  const legacy = resolveLegacyBin(env, existsFn);
  if (legacy) {
    return { kind: "launcher", launcher: { bin: legacy, args: RPC_ARGS } };
  }
  return { kind: "unavailable", missing: ["di-bin", "ts-entry", "legacy-bin"] };
}
