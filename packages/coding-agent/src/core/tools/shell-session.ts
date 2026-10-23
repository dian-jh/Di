import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { messageOf } from "./errors.ts";
import {
  createLegacyDecoder,
  createLegacyEncoder,
  discoverOemCodePage,
  smartDecode,
  type LegacyDecoder,
} from "./encoding.ts";
import { BoundedByteBuffer } from "./output-buffer.ts";
import { killProcessTree, PROCESS_KILL_BUDGET_MS, ProcessResult } from "./process-runner.ts";

/*
 * Persistent terminal session:
 * one long-lived shell process driven through stdin/stdout where cwd, environment
 * variables and virtual-env state survive across calls. Every command is followed
 * by a random per-session marker + exit-code line that bounds its output and
 * reports its exit code. Per tools-and-platform.md §"持久 shell 会话协议":
 * lazy spawn on first use, random nonce marker round-trip, stdin encoding, bounded
 * stdout/stderr drain, an async mutex serializing commands, and kill/recreate on
 * timeout / user `exit` / cancel (the session is a tree — `killProcessTree`).
 *
 * Platform differences (recorded divergences vs ):
 * - cmd stdin uses the discovered OEM code page, matching its redirected-input
 * parser. Inputs that the page cannot represent are rejected before writing.
 * PowerShell and POSIX stdin remain BOM-free UTF-8.
 * - the prompt tag (`prompt DI_<tag>$G`) is set for cmd only. sets it for sh
 * too, but a pipe-fed sh never echoes input (nothing to strip) and `prompt` is
 * not an sh builtin — it would only emit "command not found" noise on stderr.
 *
 * Internally both stdout and stderr are drained continuously into bounded byte
 * queues (so the child never blocks on a full pipe, matching BoundedByteBuffer
 * bounded-memory semantics), and each command's reader scans the queue for its
 * marker. This 's ReadAsync + carry scanning without losing bytes that
 * arrive in the same pipe chunk as a marker (Node delivers whole chunks).
 */
export type ShellSessionKind = "cmd" | "sh" | "powershell";

/** Shell command describing the session process (`ShellCommand`). */
export interface ShellCommand {
  readonly file: string;
  readonly prefixArgs: readonly string[];
  readonly sessionKind: ShellSessionKind;
}

/** Platform default shell for one-shot execution (`ShellCommand.Default`). */
export const platformDefaultShell: ShellCommand =
  process.platform === "win32"
    ? { file: process.env.COMSPEC ?? "cmd.exe", prefixArgs: ["/c"], sessionKind: "cmd" }
    : { file: "/bin/sh", prefixArgs: ["-c"], sessionKind: "sh" };

/** Platform default shell for a persistent session (`ShellCommand.SessionDefault`). */
export const platformSessionShell: ShellCommand =
  process.platform === "win32"
    ? { file: process.env.COMSPEC ?? "cmd.exe", prefixArgs: [], sessionKind: "cmd" }
    : { file: "/bin/sh", prefixArgs: [], sessionKind: "sh" };

/** PowerShell persistent session: `-Command -` reads commands from stdin (`ShellCommand.PowerShellSession`). */
export const powershellSessionShell: ShellCommand = {
  file: process.platform === "win32" ? "powershell.exe" : "pwsh",
  prefixArgs: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
  sessionKind: "powershell",
};

/** Bounded byte queue feeding the readers (never loses bytes; cap drops only idle spill). */
class ByteQueue {
  private chunks: Uint8Array[] = [];
  private size_ = 0;
  private ended_ = false;
  private waiters: Array<{
    resolve: (chunk: Uint8Array | null) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  private static readonly MAX_QUEUED = 256 * 1024;

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.chunks.push(bytes);
    this.size_ += bytes.length;
    // Bound idle spill: only safe to drop from the front while nobody is waiting
    // to read (an active reader drains faster than it fills, so the queue never
    // grows past the cap during a scan). bounds idle output with the OS pipe
    // buffer; here we drain the pipe and drop stale bytes instead, so the child
    // never blocks on a flooded pipe.
    while (this.chunks.length > 1 && this.size_ > ByteQueue.MAX_QUEUED) {
      const dropped = this.chunks.shift();
      if (dropped !== undefined) this.size_ -= dropped.length;
    }
    this.drainWaiters_();
  }

  end(): void {
    this.ended_ = true;
    this.drainWaiters_();
  }

  /** Pull the next chunk; null at EOF (or after `halt`). */
  read(signal?: AbortSignal): Promise<Uint8Array | null> {
    if (this.chunks.length > 0) {
      const chunk = this.chunks.shift()!;
      this.size_ -= chunk.length;
      return Promise.resolve(chunk);
    }
    if (this.ended_) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: (typeof this.waiters)[number] = { resolve, signal };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort!);
          resolve(null);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** Return unconsumed bytes to the FRONT of the queue (reader leftover handoff). */
  prepend(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.chunks.unshift(bytes);
    this.size_ += bytes.length;
    this.drainWaiters_();
  }

  /** Resolve every pending read with null (drain stop); future data stays queued. */
  halt(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(null);
    }
  }

  private drainWaiters_(): void {
    while (this.waiters.length > 0 && (this.chunks.length > 0 || this.ended_)) {
      const waiter = this.waiters.shift()!;
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      if (this.chunks.length > 0) {
        const chunk = this.chunks.shift()!;
        this.size_ -= chunk.length;
        waiter.resolve(chunk);
      } else {
        waiter.resolve(null);
      }
    }
  }
}

/** True when `haystack` contains `needle` at any byte offset (`IndexOf`). */
function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  const last = haystack.length - needle.length;
  for (let i = 0; i <= last; i += 1) {
    let j = 0;
    while (j < needle.length && haystack[i + j] === needle[j]) j += 1;
    if (j === needle.length) return i;
  }
  return -1;
}

/** A cancellable timer so a lost race does not leave a pending Timeout resource. */
function cancellableDelay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Format a timeout in whole or one-decimal seconds for the error observation. */
function formatTimeoutSeconds(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

/** Session-readiness timeout, ms (10s). */
const INIT_TIMEOUT_MS = 10_000;

/*
 * Persistent shell session. Lazy-spawns on first execute, serializes commands
 * through an async mutex, and self-heals: timeout, user `exit` or external cancel
 * terminate the session tree and the next call respawns it.
 */
export class ShellSession {
  private process_: ChildProcess | undefined;
  private spawnResult_: Promise<Error | null> | undefined;
  private spawnError_: string | undefined;
  private tag_ = "";
  private echoPrefix_ = new Uint8Array(0);
  private marker_ = "";
  private exitMarker_ = "";
  private initialized_ = false;
  private stdoutQueue_ = new ByteQueue();
  private stderrQueue_ = new ByteQueue();
  private stderrHalted_ = false;
  private disposed_ = false;
  private oem_: Promise<LegacyDecoder | undefined> | undefined;
  private inputEncoder_: ((text: string) => Uint8Array) | undefined;
  private inputCodePage_: number | undefined;
  private mutex_: PromiseChainMutex;

  constructor(
    private readonly workingDirectory: string,
    private readonly shell: ShellCommand = platformSessionShell,
  ) {
    if (workingDirectory.trim().length === 0) {
      throw new TypeError("workingDirectory must not be empty");
    }
    this.mutex_ = new PromiseChainMutex();
  }

  /** Whether the session process is still alive (`IsAlive`; false once disposed). */
  get isAlive(): boolean {
    if (this.disposed_) return false;
    const p = this.process_;
    return p !== undefined && p.exitCode === null && p.signalCode === null;
  }

  /*
 * Execute one command in the session. `timeoutMs` bounds the command; a timeout
 * or external cancel kills the session TREE and the next call respawns it.
 * External cancel rejects with AbortError (never an error observation).
 */
  execute(command: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
    return this.mutex_.runExclusive(async () => {
      signal?.throwIfAborted();
      if (this.shell.sessionKind === "cmd" && this.inputEncoder_ === undefined) {
        this.inputCodePage_ = await discoverOemCodePage();
        const encoder = this.inputCodePage_ === undefined ? undefined : createLegacyEncoder(this.inputCodePage_);
        if (encoder === undefined) {
          return new ProcessResult(
            -1,
            "",
            `无法使用系统 OEM 代码页 ${this.inputCodePage_ ?? "未知"} 编码终端输入；请使用 PowerShell`,
          );
        }
        this.inputEncoder_ = encoder;
      }
      if (this.shell.sessionKind === "cmd" && this.inputEncoder_ !== undefined) {
        try {
          // Preflight before spawning or writing: iconv-lite otherwise replaces
          // unrepresentable characters with `?`, while cmd can still report 0.
          this.inputEncoder_(command);
        } catch {
          return new ProcessResult(
            -1,
            "",
            `终端输入无法以系统 OEM 代码页 ${this.inputCodePage_ ?? "未知"} 无损编码；请使用 PowerShell`,
          );
        }
      }
      this.ensureAlive_();
      const process = this.process_;
      const spawnResult = this.spawnResult_;
      if (spawnResult !== undefined) {
        const spawnError = await spawnResult;
        if (spawnError !== null) {
          this.process_ = undefined;
          this.spawnError_ = `无法启动终端会话进程: ${messageOf(spawnError)}`;
          return new ProcessResult(-1, "", this.spawnError_);
        }
      }
      if (process === undefined) {
        return new ProcessResult(-1, "", this.spawnError_ ?? "无法启动终端会话进程");
      }
      if (!this.initialized_) {
        const init = await this.initialize_(process, signal);
        if (init.error !== null) return init;
      }
      return await this.runCommand_(process, command, timeoutMs, signal);
    });
  }

  /**
   * Terminate the session process (idempotent). The session is marked disposed so
   * `isAlive` reads false immediately (the tree kill itself completes async).
   */
  dispose(): void {
    if (this.disposed_) return;
    this.disposed_ = true;
    const p = this.process_;
    if (p !== undefined) void killProcessTree(p);
  }

  // ---- 内部 ----

  private ensureAlive_(): void {
    if (this.disposed_) return;
    const p = this.process_;
    if (p !== undefined && p.exitCode === null && p.signalCode === null) return;
    this.spawn_();
  }

  private spawn_(): void {
    this.tag_ = "DI_" + randomUUID().replaceAll("-", "");
    this.echoPrefix_ = Buffer.from(this.tag_ + ">", "ascii");
    this.initialized_ = false;
    this.spawnError_ = undefined;
    this.stdoutQueue_ = new ByteQueue();
    this.stderrQueue_ = new ByteQueue();
    this.stderrHalted_ = false;
    this.oem_ = undefined;

    let child: ChildProcess;
    try {
      child = spawn(this.shell.file, this.shell.prefixArgs, {
        cwd: this.workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // PowerShell's Unix console host writes cursor-mode ANSI sequences to
        // redirected stdout when TERM advertises virtual-terminal support.
        // Keep that startup traffic out of the readiness-marker protocol.
        ...(this.shell.sessionKind === "powershell" ? { env: { ...process.env, TERM: "dumb" } } : {}),
        // POSIX only: a new process group so the whole tree can be signaled
        // (Windows tree termination goes through taskkill /T, see killProcessTree).
        detached: process.platform !== "win32",
      });
    } catch (error) {
      this.process_ = undefined;
      this.spawnError_ = `无法启动终端会话进程: ${messageOf(error)}`;
      return;
    }

    // Benign error handlers so destroy()/EPIPE never surface as uncaught 'error'.
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.stdin?.on("error", () => {});

    // Startup detection: 'spawn' = started, 'error' before that = failed startup
    // (Node reports ENOENT asynchronously, unlike Process.Start's throw).
    this.spawnResult_ = new Promise<Error | null>((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", (error) => resolve(error));
    });

    // Continuous feeders: always read both pipes so the child never blocks, and
    // route the bytes into bounded queues for the per-command readers.
    this.startFeeder_(child.stdout, this.stdoutQueue_);
    this.startFeeder_(child.stderr, this.stderrQueue_);
    this.process_ = child;
  }

  private startFeeder_(stream: Readable | null, queue: ByteQueue): void {
    if (stream === null) return;
    stream.on("data", (chunk: Uint8Array) => queue.push(chunk));
    stream.on("end", () => queue.end());
    stream.on("close", () => queue.end());
    stream.on("error", () => queue.end());
  }

  /** Resolve (and cache) the OEM decoder once per session; undefined when unavailable. */
  private async oemDecoder_(): Promise<LegacyDecoder | undefined> {
    if (this.oem_ === undefined) {
      this.oem_ = (async (): Promise<LegacyDecoder | undefined> => {
        const codePage = await discoverOemCodePage();
        return codePage === undefined ? undefined : createLegacyDecoder(codePage);
      })();
    }
    return this.oem_;
  }

  /**
   * Initialize the freshly spawned session: set the unique prompt tag (cmd only),
   * preload the PowerShell progress/LASTEXITCODE prelude, and drain output until
   * the `echo <ready>` line appears. Consumes the ready
   * line fully, leaving the stream positioned right after it.
   */
  private async initialize_(process: ChildProcess, signal?: AbortSignal): Promise<ProcessResult> {
    const ready = this.tag_ + "ready";
    const lifecycle = new AbortController();
    let externalAbort = false;
    const onExternalAbort = (): void => {
      externalAbort = true;
      if (!lifecycle.signal.aborted) lifecycle.abort(signal?.reason);
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onExternalAbort();
      } else {
        signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    const timer = setTimeout(() => {
      if (!lifecycle.signal.aborted) lifecycle.abort(new Error("session init timeout"));
    }, INIT_TIMEOUT_MS);

    try {
      if (this.shell.sessionKind === "cmd") {
        await writeStdin(process.stdin, `prompt ${this.tag_}$G\n`);
      }
      if (this.shell.sessionKind === "powershell") {
        // Suppress PS 5.1's CLIXML progress stream on redirected stdout and zero
        // $LASTEXITCODE (unset is empty, which would break the marker line parse).
        // Deliberately do NOT touch [Console]::OutputEncoding — changing it makes
        // stdin read as OEM and garbles Chinese commands (comment).
        await writeStdin(process.stdin, "$ProgressPreference='SilentlyContinue'; $global:LASTEXITCODE=0;\n");
      }
      await writeStdin(process.stdin, `echo ${ready}\n`);

      const found = await this.readUntilReady_(ready, lifecycle.signal);
      if (found && !lifecycle.signal.aborted) {
        this.initialized_ = true;
        return new ProcessResult(0, "", null);
      }
      // Aborted (timeout / external) or the process died before the ready line.
      await killProcessTree(process);
      if (externalAbort) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new ProcessResult(
        -1,
        "",
        lifecycle.signal.aborted ? "终端会话初始化超时" : "终端会话初始化失败（进程提前退出）",
      );
    } finally {
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener("abort", onExternalAbort);
    }
  }

  /**
   * Run one command: write command + marker line to stdin, scan stdout for the
   * exit-code line while stderr drains in parallel, then clean + decode both.
   * Timeout / external cancel kill the session tree and return bounded partial
   * output ( semantics).
   */
  private async runCommand_(
    process: ChildProcess,
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    const lifecycle = new AbortController();
    let externalAbort = false;
    const onExternalAbort = (): void => {
      externalAbort = true;
      if (!lifecycle.signal.aborted) lifecycle.abort(signal?.reason);
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onExternalAbort();
      } else {
        signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    let timeoutTimer: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (!lifecycle.signal.aborted) lifecycle.abort(new Error("session command timeout"));
      }, timeoutMs);
    }
    const cleanup = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (signal !== undefined) signal.removeEventListener("abort", onExternalAbort);
    };

    const stdout = new BoundedByteBuffer();
    const stderr = new BoundedByteBuffer();
    this.stderrHalted_ = false;
    let stderrDrain: Promise<void> | undefined;

    try {
      // Keep the prompt tag session-scoped, but issue a fresh, unpredictable
      // boundary for each command so user output from an earlier command cannot
      // forge the current command's completion marker.
      this.marker_ = "DI_END_" + randomUUID().replaceAll("-", "");
      this.exitMarker_ = this.marker_ + "_exit";
      const input = command + "\n" + this.markerLine_() + "\n";
      await writeStdin(process.stdin, this.inputEncoder_?.(input) ?? input);

      stderrDrain = this.drainStderr_(stderr).catch(() => {});
      // Abort (timeout / external) destroys the pipes: the feeders end their
      // queues, the pending reads resolve null and the command reader returns.
      lifecycle.signal.addEventListener(
        "abort",
        () => {
          process.stdout?.destroy();
          process.stderr?.destroy();
        },
        { once: true },
      );

      const exitCode = await this.readUntilExitLine_(stdout, this.exitMarker_, lifecycle.signal);

      if (lifecycle.signal.aborted) {
        return await this.abortResult_(process, stdout, stderr, stderrDrain, timeoutMs, externalAbort, cleanup);
      }

      // Command completed: stop the stderr drain (data already queued is kept for
      // the next command, matching cancel-after-exit-line) and decode.
      this.stderrHalted_ = true;
      this.stderrQueue_.halt();
      await stderrDrain;

      const oem = await this.oemDecoder_();
      const text =
        this.cleanOutput_(decodeStdout(stdout, this.echoPrefix_, oem)) +
        this.cleanOutput_(decodeStderr(stderr, oem));

      if (externalAbort) {
        cleanup();
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      cleanup();
      return new ProcessResult(exitCode, text, null);
    } catch (error) {
      if (!lifecycle.signal.aborted) {
        cleanup();
        throw error;
      }
      // Timeout / cancel while reading: kill the tree and return partial output.
      return await this.abortResult_(
        process,
        stdout,
        stderr,
        stderrDrain ?? this.drainStderr_(stderr).catch(() => {}),
        timeoutMs,
        externalAbort,
        cleanup,
      );
    }
  }

  /** Shared abort handling: kill the tree, await close (bounded), settle drains, decode partial. */
  private async abortResult_(
    process: ChildProcess,
    stdout: BoundedByteBuffer,
    stderr: BoundedByteBuffer,
    stderrDrain: Promise<void>,
    timeoutMs: number,
    externalAbort: boolean,
    cleanup: () => void,
  ): Promise<ProcessResult> {
    // Attach the close listener BEFORE the kill: taskkill takes ~2s and the
    // child's close fires during it — attaching after would miss the event and
    // burn the whole kill budget waiting for a close that already happened.
    const closePromise = new Promise<void>((resolve) => {
      process.once("close", () => resolve());
    });
    await killProcessTree(process);
    const budget = cancellableDelay(PROCESS_KILL_BUDGET_MS);
    const closed = await Promise.race([closePromise.then(() => true), budget.promise.then(() => false)]);
    if (closed) budget.cancel();
    if (!closed) {
      process.stdout?.destroy();
      process.stderr?.destroy();
    }
    this.stderrHalted_ = true;
    this.stderrQueue_.halt();
    await Promise.allSettled([stderrDrain]);
    const oem = await this.oemDecoder_();
    const partial =
      this.cleanOutput_(decodeStdout(stdout, this.echoPrefix_, oem)) +
      this.cleanOutput_(decodeStderr(stderr, oem));
    cleanup();
    if (externalAbort) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    return new ProcessResult(
      -1,
      partial,
      `执行超过 ${formatTimeoutSeconds(timeoutMs)} 秒未完成，已终止终端会话（下次调用自动重建）`,
    );
  }

  /** Background stderr drain into the per-command bounded buffer; stops on halt/EOF. */
  private async drainStderr_(buffer: BoundedByteBuffer): Promise<void> {
    try {
      while (!this.stderrHalted_) {
        const chunk = await this.stderrQueue_.read();
        if (chunk === null) return;
        buffer.append(chunk);
      }
    } catch {
      // destroyed / halted: benign (DrainAsync catches OCE + IOException)
    }
  }

  /** Marker line written after every command. */
  private markerLine_(): string {
    switch (this.shell.sessionKind) {
      case "cmd":
        return `echo ${this.marker_} & echo ${this.exitMarker_}:%errorlevel%`;
      case "powershell":
        // PS 5.1 semantics: cmdlet success -> $? true (use $LASTEXITCODE, init 0);
        // native failure -> $? false and $LASTEXITCODE is the real code; unknown
        // command -> $? false and $LASTEXITCODE stays 0 -> fallback to 1.
        return (
          `$ok=$?; $rc=$global:LASTEXITCODE; if (-not $ok) { $rc=[Math]::Max(1,$rc) }; ` +
          `Write-Output '${this.marker_}'; Write-Output ('${this.exitMarker_}:' + $rc)`
        );
      default:
        return `__di_rc=$?; echo ${this.marker_}; echo ${this.exitMarker_}:$__di_rc`;
    }
  }

  /**
   * Read stdout until a line exactly equal to `ready` and consume the whole line
   * (banner / echo noise before it is discarded). Returns false if the session
   * died first. The search target is "\n" + ready so a stream that starts with
   * the ready line (PS has no banner) still matches via the synthetic leading \n.
   */
  private async readUntilReady_(ready: string, signal: AbortSignal): Promise<boolean> {
    const readyBytes = Buffer.from(ready, "ascii");
    const target = Buffer.concat([Buffer.from([0x0a]), readyBytes]);
    let carry: Uint8Array = Buffer.alloc(target.length - 1);
    let carryLen = 1;
    carry[0] = 0x0a; // synthetic leading \n: stream may start with the ready line

    while (true) {
      if (signal.aborted) return false;
      const chunk = await this.stdoutQueue_.read(signal);
      if (chunk === null) return false; // session ended without the ready line
      const combined = Buffer.concat([carry.subarray(0, carryLen), chunk]);
      const at = indexOf(combined, target);
      if (at < 0) {
        carryLen = Math.min(target.length - 1, combined.length);
        carry = combined.subarray(combined.length - carryLen);
        continue;
      }
      // Found the ready line start: consume through the line's own \n (may cross
      // chunks), return the rest of that chunk to the queue for the first command.
      const searchFrom = at + target.length;
      const nl = combined.indexOf(0x0a, searchFrom);
      if (nl >= 0) {
        this.stdoutQueue_.prepend(combined.subarray(nl + 1));
        return true;
      }
      while (true) {
        const c = await this.stdoutQueue_.read(signal);
        if (c === null) return true; // line end truncated by session end; ready appeared
        const inner = c.indexOf(0x0a);
        if (inner >= 0) {
          this.stdoutQueue_.prepend(c.subarray(inner + 1));
          return true;
        }
        // bytes without a newline are the ready line's tail; discard them
      }
    }
  }

  /**
   * Read stdout until the exit-code line boundary ("\n" + exitMarker). Bytes
   * before the boundary accumulate in `output` (marker line included; CleanOutput
   * strips it later). Returns the parsed exit code, or the process exit code when
   * the session ended without a boundary. The trailing prompt display after the
   * boundary is consumed and discarded by parseExitLine_.
   */
  private async readUntilExitLine_(
    output: BoundedByteBuffer,
    exitMarker: string,
    signal: AbortSignal,
  ): Promise<number> {
    const exitMarkerBytes = Buffer.from("\n" + exitMarker, "ascii");
    let carry: Uint8Array = Buffer.alloc(exitMarkerBytes.length - 1);
    let carryLen = 0;

    while (true) {
      if (signal.aborted) return -1;
      const chunk = await this.stdoutQueue_.read();
      if (chunk === null) {
        // Stream ended without the exit line. On abort the pipes were destroyed
        // (the process may still be alive) — return immediately, never wait. Only
        // when the process really exited (user `exit`, crash) do we fetch its code.
        if (signal.aborted) return -1;
        const p = this.process_;
        return p !== undefined ? await this.waitExitCode_(p) : -1;
      }
      const combined =
        carryLen > 0 ? Buffer.concat([carry.subarray(0, carryLen), chunk]) : chunk;
      const at = indexOf(combined, exitMarkerBytes);
      if (at >= 0) {
        // Only append the NEW bytes before the marker (the carry bytes were
        // already appended on a previous iteration — never duplicate, or a clean
        // UTF-8 stream would be corrupted and mis-decoded as OEM).
        const newBefore = at - carryLen;
        if (newBefore > 0) output.append(chunk.subarray(0, newBefore));
        const leading = combined.subarray(at + exitMarkerBytes.length);
        return await this.parseExitLine_(leading, signal);
      }
      output.append(chunk);
      carryLen = Math.min(exitMarkerBytes.length - 1, combined.length);
      carry = combined.subarray(combined.length - carryLen);
    }
  }

  /**
   * Resolve the child's exit code when the session ended without an exit line
   * (user `exit`, or a crash). The stdout stream can close just before the
   * process 'exit' event / `exitCode` are populated, so await the event; the
   * re-check covers the check-then-attach race. Bounded: a stream that ended
   * while the process is still alive (abnormal) must not hang the call.
   */
  private async waitExitCode_(process: ChildProcess): Promise<number> {
    if (process.exitCode !== null) return process.exitCode;
    const exitPromise = new Promise<number>((resolve) => {
      process.once("exit", (code) => resolve(code ?? -1));
      if (process.exitCode !== null) resolve(process.exitCode);
    });
    const budget = cancellableDelay(2000);
    const code = await Promise.race([exitPromise, budget.promise.then(() => -1)]);
    if (code !== -1) budget.cancel();
    return code;
  }

  /** Parse the exit-code line: leading (starts ":N\r\n") + read to the newline. */
  private async parseExitLine_(leading: Uint8Array, signal: AbortSignal): Promise<number> {
    let line = Buffer.from(leading);
    while (true) {
      const nl = line.indexOf(0x0a);
      if (nl >= 0) {
        line = line.subarray(0, nl);
        break;
      }
      if (line.length > 512) break; // guard: an exit line is never this long
      if (signal.aborted) break;
      const chunk = await this.stdoutQueue_.read();
      if (chunk === null) break;
      line = Buffer.concat([line, chunk]);
    }
    const text = line.toString("ascii").trim();
    const colon = text.lastIndexOf(":");
    const number = colon >= 0 ? text.slice(colon + 1) : text;
    const code = Number.parseInt(number, 10);
    return Number.isInteger(code) && !Number.isNaN(code) ? code : 0;
  }

  /**
   * Clean one decoded segment: drop lines starting with the prompt tag, trim
   * leading blank lines, trim trailing whitespace and strip the glued marker
   *.
   */
  private cleanOutput_(decoded: string): string {
    const lines = decoded.replace(/\r\n/g, "\n").split("\n");
    const kept = lines.filter((line) => !line.startsWith(this.tag_));
    let text = kept.join("\n").replace(/^[\n\r]+/, "");
    const trimmed = text.replace(/[\r \n]+$/, "");
    if (trimmed.endsWith(this.marker_)) {
      text = text.slice(0, trimmed.length - this.marker_.length);
    }
    return text;
  }
}

/** Decode the stdout segment: strip byte-level echo lines (cmd prompt-echo), then smart decode. */
function decodeStdout(
  buffer: BoundedByteBuffer,
  echoPrefix: Uint8Array,
  oem: LegacyDecoder | undefined,
): string {
  return decodeText(buffer, (bytes) => stripEchoLines(bytes, echoPrefix), oem);
}

/** Decode the stderr segment (no echo lines; engine errors are OEM bytes). */
function decodeStderr(buffer: BoundedByteBuffer, oem: LegacyDecoder | undefined): string {
  return decodeText(buffer, (bytes) => bytes, oem);
}

/** Smart-decode a segment through the bounded buffer; explicit decode errors surface as text. */
function decodeText(
  buffer: BoundedByteBuffer,
  prepare: (bytes: Uint8Array) => Uint8Array,
  oem: LegacyDecoder | undefined,
): string {
  try {
    return buffer.toText((bytes) => {
      const prepared = prepare(bytes);
      if (oem !== undefined) return smartDecode(prepared, oem);
      const strict = strictUtf8WithSeamTrim(prepared);
      if (strict !== null) return strict;
      throw new OutputDecodeError();
    });
  } catch (error) {
    if (error instanceof OutputDecodeError) {
      return "error: 无法解码：非 UTF-8 且系统 OEM 解码器不可用";
    }
    throw error;
  }
}

/** Sentinel for an explicit decode failure (surfaced as an error observation). */
class OutputDecodeError extends Error {}

/** Strict UTF-8 with the 1–3 byte seam trims (SmartDecode's UTF-8 path without OEM). */
function strictUtf8WithSeamTrim(bytes: Uint8Array): string | null {
  const whole = tryStrictUtf8(bytes);
  if (whole !== null) return whole;
  for (let cut = 1; cut <= 3 && bytes.length > cut; cut += 1) {
    const s = tryStrictUtf8(bytes.subarray(0, bytes.length - cut));
    if (s !== null) return s;
  }
  for (let cut = 1; cut <= 3 && bytes.length > cut; cut += 1) {
    const s = tryStrictUtf8(bytes.subarray(cut));
    if (s !== null) return s;
  }
  return null;
}

function tryStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Byte-level echo-line filter: drop lines starting with the prompt tag (cmd only). */
function stripEchoLines(raw: Uint8Array, echoPrefix: Uint8Array): Uint8Array {
  if (echoPrefix.length === 0 || raw.length === 0) return raw;
  const parts: Uint8Array[] = [];
  let lineStart = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== 0x0a) continue;
    if (!startsWithAt(raw, lineStart, i - lineStart, echoPrefix)) {
      parts.push(raw.subarray(lineStart, i + 1)); // keep the \n
    }
    lineStart = i + 1;
  }
  if (lineStart < raw.length && !startsWithAt(raw, lineStart, raw.length - lineStart, echoPrefix)) {
    parts.push(raw.subarray(lineStart));
  }
  if (parts.length === 0) return new Uint8Array(0);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
}

/** Whether raw[offset.. offset+len) starts with prefix. */
function startsWithAt(raw: Uint8Array, offset: number, len: number, prefix: Uint8Array): boolean {
  if (len < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (raw[offset + i] !== prefix[i]) return false;
  }
  return true;
}

/** Write one line to the child's stdin, honoring backpressure (errors benign). */
async function writeStdin(stdin: Writable | null, text: string | Uint8Array): Promise<void> {
  if (stdin === null) return;
  if (stdin.write(text)) return;
  await new Promise<void>((resolve) => {
    const onDrain = (): void => {
      stdin.removeListener("error", onError);
      resolve();
    };
    const onError = (): void => {
      stdin.removeListener("drain", onDrain);
      resolve();
    };
    stdin.once("drain", onDrain);
    stdin.once("error", onError);
  });
}

/** Promise-chain mutex serializing session commands. */
class PromiseChainMutex {
  private chain: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(() => fn());
    this.chain = result.catch(() => undefined);
    return result;
  }
}
