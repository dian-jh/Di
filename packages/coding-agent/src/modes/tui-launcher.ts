import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

/*
 * Interactive-mode frontend decision: interactive defaults to handing the console to the TS TUI (node
 * subprocess inheriting stdio) and falls back to the REPL when unavailable.
 * All external dependencies (env / entry resolution / node probe / spawn) go
 * through the injectable {@link TuiLauncherContext} so tests never open a real
 * process. Rules: `DI_UI=repl` (exact) forces the REPL; otherwise `DI_TUI` (file
 * or a directory containing dist/main.js) ?? `~/.di/tui/dist/main.js` with a
 * resolvable node → hand to the TUI. Spawn throw / non-zero exit → fall back to
 * the REPL.
 */

/** The default TUI install location (relative to home): install.* builds and copies to ~/.di/tui. */
export const TUI_DEFAULT_RELATIVE_ENTRY = ".di/tui/dist/main.js";

/** Dependency injection points (production uses real defaults; tests replace with fakes). */
export interface TuiLauncherContext {
  /** Read an environment variable (default `process.env[name]`). */
  getEnv?: (name: string) => string | undefined;
  /** Home directory (win32 uses USERPROFILE, falls back to HOME); base of the default entry. */
  userHome?: string;
  /** Entry resolution (input DI_TUI value → entry file path; undefined = not resolvable). */
  resolveEntry?: (diTui: string) => string | undefined;
  /** node resolvability probe (default spawn node --version). */
  nodeAvailable?: () => boolean;
  /** Spawn node <entry> (inheriting stdio, waits for exit) → exit code; a throw counts as spawn failure. */
  spawn?: (entry: string) => number;
}

/** The decision: managed=true means the TUI took over the console and exited normally. */
export interface TuiDecision {
  readonly managed: boolean;
  readonly exitCode: number;
  readonly fallbackReason?: string;
}

/** Make the decision and, when available, actually launch the TUI. */
export function tryLaunchTui(context?: TuiLauncherContext): TuiDecision {
  const ctx = context ?? {};
  const getEnv = ctx.getEnv ?? ((name: string) => process.env[name]);

  // 逃生门：DI_UI=repl（精确匹配）→ 强制使用 REPL，绝不开 TUI。
  if (getEnv("DI_UI") === "repl") return { managed: false, exitCode: 0, fallbackReason: "DI_UI=repl，使用 REPL" };

  // 入口解析：DI_TUI（文件 / 含 dist/main.js 的目录）?? ~/.di/tui/dist/main.js。
  const resolved = resolveEntry(ctx, getEnv);
  if (resolved.entry === undefined) {
    return { managed: false, exitCode: 0, fallbackReason: `未找到 TUI 入口（${resolved.shown}），回退 REPL` };
  }

  // node 可解析探测（此时尚未开 TUI 进程）。
  if (!(ctx.nodeAvailable?.() ?? probeNode())) {
    return { managed: false, exitCode: 0, fallbackReason: "未找到 node，回退 REPL" };
  }

  // spawn node <entry>：继承 stdio（TUI 必须拥有控制台），等待退出。
  try {
    const exitCode = (ctx.spawn ?? spawnTui)(resolved.entry);
    if (exitCode !== 0) return { managed: false, exitCode, fallbackReason: `TUI 退出（exit ${exitCode}），回退 REPL` };
    return { managed: true, exitCode };
  } catch (error) {
    return { managed: false, exitCode: 0, fallbackReason: `启动 TUI 失败（${errorMessage(error)}），回退 REPL` };
  }
}

function resolveEntry(
  ctx: TuiLauncherContext,
  getEnv: (name: string) => string | undefined,
): { entry: string | undefined; shown: string } {
  if (ctx.resolveEntry !== undefined) {
    return { entry: ctx.resolveEntry(getEnv("DI_TUI") ?? ""), shown: "(DI_TUI)" };
  }

  const diTui = getEnv("DI_TUI");
  if (diTui !== undefined && diTui.trim().length > 0) {
    if (isFile(diTui)) return { entry: diTui, shown: diTui };
    const dirEntry = join(diTui, "dist", "main.js");
    if (isDirectory(diTui) && isFile(dirEntry)) return { entry: dirEntry, shown: dirEntry };
    return { entry: undefined, shown: diTui };
  }

  const home = ctx.userHome ?? getEnv("USERPROFILE") ?? getEnv("HOME");
  if (home === undefined || home.trim().length === 0) {
    return { entry: undefined, shown: "~/.di/tui/dist/main.js" };
  }
  const defaultEntry = join(home, TUI_DEFAULT_RELATIVE_ENTRY);
  return isFile(defaultEntry) ? { entry: defaultEntry, shown: defaultEntry } : { entry: undefined, shown: defaultEntry };
}

/** Default node probe: spawn node --version (short timeout; failure counts as unavailable). */
function probeNode(): boolean {
  try {
    const result = spawnSync("node", ["--version"], { stdio: "ignore", timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Default spawn: node <entry>, inheriting stdio (the TUI owns the console), waits for exit. */
function spawnTui(entry: string): number {
  const result = spawnSync("node", [entry], { stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
