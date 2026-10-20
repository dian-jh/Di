import { spawn } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { basename } from "node:path";
import { messageOf } from "./errors.ts";
import { BoundedByteBuffer } from "./output-buffer.ts";
import { smartDecode, type LegacyDecoder } from "./encoding.ts";
import { resolveOemDecoder } from "./read.ts";
import { ProcessDiagnostics } from "../logging/process-diagnostics.ts";

/**
 * One-shot process runner (port of `Core/Tools/ProcessRunner.cs` at 09f4e08 +
 * the P4-win-process-probe conclusions).
 *
 * Lifecycle: a single internal AbortController unifies the tool timeout and the
 * external AbortSignal. Whichever fires first triggers the same teardown —
 * kill the process TREE (Windows `taskkill /PID <pid> /T /F`, POSIX
 * `detached`-group SIGTERM then SIGKILL), await the original process's `close`
 * within a bounded budget, settle the drains and free every listener/timer/stream.
 *
 * Output: stdout and stderr are drained IN PARALLEL into one bounded byte ring
 * (head 6000 / tail 18000 bytes with a truncation notice; never unbounded
 * concatenation, never collect-then-truncate). The whole segment is decoded only
 * after exit (`outputEncoding` pinned, or UTF-8-first/OEM-fallback smart decode)
 * so a mixed cmd-OEM / .NET-CLI-UTF-8 stream decodes correctly.
 *
 * After a natural exit the drains get an independent ~1s budget: a background
 * child that inherited the pipes cannot hang the call forever — on budget expiry
 * the read ends are cut off and the partial output returned. Non-zero exit code
 * and failed startup are observation text (`exit: N` / `error: …`), never throws;
 * external cancel propagates AbortError.
 */

/** Drain budget after a natural exit, ms (C# `DrainTimeoutMs`). */
export const PROCESS_DRAIN_BUDGET_MS = 1000;
/** Budget to await the process `close` after a tree kill, ms (P4-win-process-probe §2: 5s). */
export const PROCESS_KILL_BUDGET_MS = 5000;
/** POSIX SIGTERM grace before SIGKILL when killing the process group. */
const POSIX_KILL_GRACE_MS = 1500;

/**
 * Process-diagnostics knobs (P7a closing the P6.4 emission seam; C#
 * `Core/Tools/ProcessRunner.cs` at baseline 09f4e08): the runner emits bypass
 * `proc: start / start_failed / running / timeout / exited` lines through the
 * static {@link ProcessDiagnostics} hook. The heartbeat cadence and the
 * slow-success threshold are injectable so tests observe them without a
 * multi-second run (production defaults mirror C#).
 */
export interface ProcessDiagnosticsOptions {
  /** Heartbeat cadence, ms (C# 5000); `proc: running` lines emitted while the process lives. */
  readonly heartbeatIntervalMs?: number;
  /** Heartbeat tick cadence, ms (C# 1000); the process-liveness poll. */
  readonly heartbeatTickMs?: number;
  /** Minimum timeout for the heartbeat to start, ms (C# 3000 = `timeout >= 3s`). */
  readonly heartbeatMinTimeoutMs?: number;
  /** Minimum elapsed time for the `proc: exited` slow-success line, ms (C# 2000). */
  readonly exitedMinElapsedMs?: number;
}

export interface ProcessRunOptions {
  /** Working directory (spawn cwd). */
  readonly cwd?: string;
  /** Extra environment variables, merged over the parent environment (C# `psi.Environment` overrides). */
  readonly env?: Readonly<Record<string, string>>;
  /** Tool timeout in milliseconds; undefined = no timeout. */
  readonly timeoutMs?: number;
  /** External cancellation; aborting propagates AbortError and kills the tree. */
  readonly signal?: AbortSignal;
  /** Pin the output decoder label (e.g. "utf-8" for python); undefined = smart decode. */
  readonly outputEncoding?: string;
  /** Spawn stdio config; default [ignore, pipe, pipe]. */
  readonly stdio?: StdioOptions;
  /** Drain budget after a natural exit, ms (default 1000). */
  readonly drainBudgetMs?: number;
  /** Budget to await process close after a tree kill, ms (default 5000). */
  readonly killBudgetMs?: number;
  /** Override the OEM code page used for non-UTF-8 decode (undefined = auto-discover). */
  readonly oemCodePage?: number;
  /** Process-diagnostic knobs (heartbeat cadence / slow-success threshold); undefined = C# defaults. */
  readonly diagnostics?: ProcessDiagnosticsOptions;
  /**
   * Run the command through the platform default shell (`shell: true`). When
   * true, `[file, ...args].join(" ")` is passed as ONE command-line string to
   * `spawn(..., { shell: true })` — Node on Windows wraps it as
   * `comspec /d /s /c "<line>"` (equivalent to C# `ProcessRunner`'s
   * `rawArguments` for cmd, so embedded quotes are preserved verbatim and
   * `&` / redirection / `%CD%` work), on POSIX as `/bin/sh -c <line>` (one arg,
   * equivalent to C# `ShellCommand.Default` args array). Default false: all
   * existing behavior is unchanged (args-array spawn, no shell quoting).
   */
  readonly shell?: boolean;
}

/** One process execution result, rendered as the tool observation text. */
export class ProcessResult {
  constructor(
    readonly exitCode: number | null,
    readonly output: string,
    readonly error: string | null,
  ) {}

  /** Render as observation text: `exit: N` on success; `error: …` first on failure. */
  toObservation(): string {
    const trimmed = this.output.trimEnd();
    if (this.error === null) return `exit: ${this.exitCode ?? -1}\n${trimmed}`;
    return trimmed.length > 0 ? `error: ${this.error}\n${trimmed}` : `error: ${this.error}`;
  }
}

/** Execute one process; resolves with the bounded output result. */
export async function runProcess(
  file: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessResult> {
  const {
    cwd,
    env,
    timeoutMs,
    signal: externalSignal,
    outputEncoding,
    stdio,
    drainBudgetMs = PROCESS_DRAIN_BUDGET_MS,
    killBudgetMs = PROCESS_KILL_BUDGET_MS,
    oemCodePage,
    diagnostics,
    shell = false,
  } = options;
  const heartbeatIntervalMs = diagnostics?.heartbeatIntervalMs ?? 5000;
  const heartbeatTickMs = diagnostics?.heartbeatTickMs ?? 1000;
  const heartbeatMinTimeoutMs = diagnostics?.heartbeatMinTimeoutMs ?? 3000;
  const exitedMinElapsedMs = diagnostics?.exitedMinElapsedMs ?? 2000;
  const programName = basename(file);
  const startedAt = Date.now();

  // Already-cancelled at entry: propagate cancel without starting anything.
  if (externalSignal?.aborted === true) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  const buffer = new BoundedByteBuffer();
  const lifecycle = new AbortController();
  let timedOut = false;
  let externalAbort = false;
  const cleanupFns: Array<() => void> = [];

  // ---- unified lifecycle: timeout timer + external signal -> one abort ----
  let timeoutTimer: NodeJS.Timeout | undefined;
  const onExternalAbort = (): void => {
    externalAbort = true;
    if (!lifecycle.signal.aborted) lifecycle.abort(externalSignal?.reason);
  };
  if (externalSignal !== undefined) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (!lifecycle.signal.aborted) lifecycle.abort(new Error("process timeout"));
    }, timeoutMs);
  }

  const cleanup = (): void => {
    while (cleanupFns.length > 0) cleanupFns.pop()!();
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
    if (externalSignal !== undefined) externalSignal.removeEventListener("abort", onExternalAbort);
  };

  // ---- spawn ----
  // Default: args array, never a shell string (no shell-quoting injection).
  // `shell: true` (bash tool, platform default shell): the joined line is passed
  // to spawn with shell:true so Node itself constructs `comspec /d /s /c "<line>"`
  // on Windows (= C# `rawArguments`, embedded quotes preserved, `&`/redirection/
  // `%CD%` work) and `/bin/sh -c <line>` on POSIX (one arg, = C# args array). All
  // lifecycle semantics (tree kill, bounded drain, timeout/cancel, startup
  // failure) are identical either way — no separate spawn path bypasses it.
  let child: ChildProcess;
  try {
    child = shell
      ? spawn([file, ...args].join(" "), {
          cwd,
          env: mergeEnv(env),
          stdio: stdio ?? ["ignore", "pipe", "pipe"],
          shell: true,
          windowsHide: true,
          // POSIX only: a new process group so the whole tree can be signaled.
          detached: process.platform !== "win32",
        })
      : spawn(file, args, {
          cwd,
          env: mergeEnv(env),
          stdio: stdio ?? ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
          // POSIX only: a new process group so the whole tree can be signaled.
          detached: process.platform !== "win32",
        });
  } catch (error) {
    diagnose(`proc: start_failed name=${programName} error=${truncateField(messageOf(error))}`);
    cleanup();
    return new ProcessResult(-1, "", `无法启动进程: ${messageOf(error)}`);
  }
  cleanupFns.push(() => child.removeAllListeners());

  const destroyStreams = (): void => {
    child.stdout?.destroy();
    child.stderr?.destroy();
  };

  // Drain stdout/stderr in parallel into the single bounded byte ring. Errors are
  // benign (abort destroy / IO), matching C# DrainAsync.
  const drainTasks = [drainStream(child.stdout, buffer), drainStream(child.stderr, buffer)];

  // Startup detection: 'spawn' = started, 'error' before that = failed startup.
  const spawnFailure = await new Promise<Error | null>((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", (error) => resolve(error));
  });
  if (spawnFailure !== null) {
    diagnose(`proc: start_failed name=${programName} error=${truncateField(messageOf(spawnFailure))}`);
    destroyStreams();
    await Promise.allSettled(drainTasks);
    cleanup();
    return new ProcessResult(-1, "", `无法启动进程: ${messageOf(spawnFailure)}`);
  }

  // ---- process-level diagnostics (proc: lines, see ProcessDiagnostics) ----
  // The bypass hook must never affect execution: diagnose() guards everything.
  diagnose(
    `proc: start name=${programName} pid=${child.pid ?? 0} timeout_s=${formatTimeoutSeconds(timeoutMs)}` +
      ` cwd=${truncateField(cwd ?? "")} cmd=<<${truncateField(commandLine(file, args))}>>`,
  );
  const heartbeat = startHeartbeatMonitor(child, timeoutMs, programName, startedAt, {
    intervalMs: heartbeatIntervalMs,
    tickMs: heartbeatTickMs,
    minTimeoutMs: heartbeatMinTimeoutMs,
  });
  if (heartbeat !== null) cleanupFns.push(heartbeat.stop);

  const childExit = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  const childClose = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });

  const abortRace = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(lifecycle.signal.reason);
    if (lifecycle.signal.aborted) {
      onAbort();
      return;
    }
    lifecycle.signal.addEventListener("abort", onAbort, { once: true });
    cleanupFns.push(() => lifecycle.signal.removeEventListener("abort", onAbort));
  });

  // ---- main wait: process exit vs unified abort ----
  let exitCode: number | null;
  try {
    exitCode = await Promise.race([childExit, abortRace]);
  } catch {
    // Unified abort: timeout or external cancel -> kill the TREE, await close,
    // settle drains, then decide the semantics (C# catch Order of WaitForExitAsync).
    await killProcessTree(child);
    const budget = cancellableDelay(killBudgetMs);
    const closed = await Promise.race([childClose.then(() => true), budget.promise.then(() => false)]);
    if (closed) budget.cancel(); // close won: drop the still-pending budget timer
    if (!closed) destroyStreams();
    await Promise.allSettled(drainTasks);
    const partial = await decodeOutput(buffer, outputEncoding, oemCodePage);
    if (!externalAbort) {
      diagnose(
        `proc: timeout name=${programName} pid=${child.pid ?? 0} elapsed_ms=${Date.now() - startedAt}` +
          ` partial=<<${truncateField(partial, 300)}>>`,
      );
    }
    cleanup();
    if (externalAbort) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    return new ProcessResult(-1, partial, `执行超过 ${formatTimeoutSeconds(timeoutMs)} 秒未完成，已终止`);
  }

  // Natural exit: the drains get an independent budget (a child inheriting the
  // pipes must never hang the call forever). Then honour a cancel that raced the
  // exit (C# `cancellationToken.ThrowIfCancellationRequested()` after drain).
  const drainBudget = cancellableDelay(drainBudgetMs);
  const drained = await Promise.race([
    Promise.all(drainTasks).then(() => true),
    drainBudget.promise.then(() => false),
  ]);
  if (drained) drainBudget.cancel();
  if (!drained) destroyStreams();
  await Promise.allSettled(drainTasks);
  // A cancel that raced the exit wins (C# `ThrowIfCancellationRequested` after
  // the drain); `externalAbort` is the mutable flag so TypeScript cannot narrow
  // it away — the signal may abort at any await point.
  if (externalAbort) {
    cleanup();
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  const output = await decodeOutput(buffer, outputEncoding, oemCodePage);
  // Slow-success (>=2s default): a normal multi-second command gets a record too,
  // so a later timeout can be compared against how long the command normally took.
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs >= exitedMinElapsedMs) {
    diagnose(`proc: exited name=${programName} pid=${child.pid ?? 0} exit=${exitCode ?? -1} elapsed_ms=${elapsedMs}`);
  }
  cleanup();
  return new ProcessResult(exitCode, output, null);
}

/** Drain one pipe into the bounded ring; aborted/destroyed/IO errors are silent. */
async function drainStream(stream: NodeJS.ReadableStream | null, buffer: BoundedByteBuffer): Promise<void> {
  if (stream === null) return;
  try {
    for await (const chunk of stream) {
      buffer.append(chunk as Uint8Array);
    }
  } catch {
    // aborted / destroyed / IO error: benign (C# DrainAsync catches OCE + IOException).
  }
}

/** Kill the process tree: Windows taskkill /PID /T /F; POSIX group SIGTERM->SIGKILL. */
async function killProcessTree(child: ChildProcess): Promise<void> {
  // Already exited naturally (benign race): nothing to kill (probe §4: taskkill
  // on a dead PID returns 128 — skip it).
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await taskkillTree(pid);
  } else {
    await posixKillGroup(pid);
  }
}

/** Windows tree kill: `taskkill /PID <pid> /T /F`, argv form (probe §7.1). */
function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    let killer: ChildProcess;
    try {
      killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      resolve(); // taskkill unavailable: best effort (the caller still awaits close)
      return;
    }
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    killer.once("error", finish);
    killer.once("close", finish);
  });
}

/** POSIX group kill: SIGTERM, short grace, then SIGKILL (probe §7.6). */
async function posixKillGroup(pid: number): Promise<void> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // ESRCH: already gone.
  }
  await new Promise((resolve) => setTimeout(resolve, POSIX_KILL_GRACE_MS));
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: already gone.
  }
}

/** Decode the bounded bytes after exit: pinned encoding, or smart decode. */
async function decodeOutput(
  buffer: BoundedByteBuffer,
  pinned: string | undefined,
  oemCodePage: number | undefined,
): Promise<string> {
  const oem = pinned === undefined ? await resolveOemDecoder({ oemCodePage }) : undefined;
  try {
    return buffer.toText((bytes) => {
      const text = decodeSegment(bytes, pinned, oem);
      if (text === null) throw new OutputDecodeError();
      return text;
    });
  } catch (error) {
    if (error instanceof OutputDecodeError) return "error: 无法解码：非 UTF-8 且系统 OEM 解码器不可用";
    throw error;
  }
}

/**
 * Decode one byte segment: pinned label (non-fatal, C# `GetString` parity) or
 * smart decode. Without an OEM decoder, strict UTF-8 with the 1–3 byte seam
 * trims only; failure returns null (explicit decode error, never mojibake).
 */
function decodeSegment(
  bytes: Uint8Array,
  pinned: string | undefined,
  oem: LegacyDecoder | undefined,
): string | null {
  if (pinned !== undefined) {
    try {
      return new TextDecoder(pinned).decode(bytes);
    } catch {
      return null;
    }
  }
  if (oem !== undefined) return smartDecode(bytes, oem);
  const whole = strictUtf8OrNull(bytes);
  if (whole !== null) return whole;
  for (let cut = 1; cut <= 3 && bytes.length > cut; cut += 1) {
    const s = strictUtf8OrNull(bytes.subarray(0, bytes.length - cut));
    if (s !== null) return s;
  }
  for (let cut = 1; cut <= 3 && bytes.length > cut; cut += 1) {
    const s = strictUtf8OrNull(bytes.subarray(cut));
    if (s !== null) return s;
  }
  return null;
}

function strictUtf8OrNull(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Sentinel for an explicit decode failure (surfaced as an error observation). */
class OutputDecodeError extends Error {}

/** Merge env overrides over the parent environment (C# `psi.Environment` semantics). */
function mergeEnv(overrides: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv | undefined {
  if (overrides === undefined) return undefined;
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) merged[key] = value;
  return merged;
}

/** Format a timeout in whole or one-decimal seconds for the error observation. */
function formatTimeoutSeconds(timeoutMs: number | undefined): string {
  const seconds = (timeoutMs ?? 0) / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

// ---- process-level diagnostics (proc: lines, see ProcessDiagnostics) ----

/**
 * Emit one process-diagnostic line: the hook is nullable and exceptions are
 * swallowed — diagnostics are a bypass observation and must never affect the
 * process they are watching (C# `ProcessRunner.Diagnose`).
 */
function diagnose(message: string): void {
  try {
    ProcessDiagnostics.log?.(message);
  } catch {
    // Diagnostics never throw.
  }
}

/** Collapse control characters and truncate long fields (C# `TruncateField`: 200, 300 for partial). */
function truncateField(text: string, max = 200): string {
  const flat = text.replace(/\r/g, " ").replace(/\n/g, " ");
  return flat.length <= max ? flat : flat.slice(0, max) + "…";
}

/** Reconstruct the command line for the `proc: start` line (C# `BuildCommandLine`). */
function commandLine(file: string, args: readonly string[]): string {
  return args.length === 0 ? file : `${file} ${args.join(" ")}`;
}

/**
 * Heartbeat monitor (C# `StartHeartbeatMonitorAsync`): poll the process liveness
 * every `tickMs` (C# 1s) and emit a `proc: running` line every `intervalMs`
 * (C# 5s) while it lives within the timeout. Only started when the timeout is
 * long enough to matter (C# `timeout >= 3s`). Returns a stop token, or null
 * when the monitor is not started; the monitor is also stopped when the process
 * exits and via the caller's cleanup list.
 */
function startHeartbeatMonitor(
  child: ChildProcess,
  timeoutMs: number | undefined,
  name: string,
  startedAt: number,
  options: { intervalMs: number; tickMs: number; minTimeoutMs: number },
): { stop: () => void } | null {
  if (timeoutMs === undefined || timeoutMs < options.minTimeoutMs) return null;
  let stopped = false;
  let lastBeat = 0;
  const interval = setInterval(() => {
    if (stopped) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      clearInterval(interval);
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs - lastBeat >= options.intervalMs) {
      lastBeat = elapsedMs;
      diagnose(`proc: running name=${name} pid=${child.pid ?? 0} elapsed_ms=${elapsedMs}`);
    }
  }, options.tickMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

/** A cancellable timer so a lost race does not leave a pending Timeout resource. */
function cancellableDelay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}
