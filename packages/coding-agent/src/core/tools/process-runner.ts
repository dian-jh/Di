/**
 * One-shot process runner — SCAFFOLD for the P4.4 red tests.
 *
 * The public API surface (`runProcess` / `ProcessResult`) is correct, but the
 * host behavior is NOT implemented: `runProcess` never spawns and always resolves
 * with an empty success result, so every business assertion (exit text, non-zero
 * exit, parallel bounded stderr drain, timeout error + partial, AbortError
 * propagation, tree-kill with no survivors, failed-startup observation) fails
 * red. The green commit replaces this scaffold with the real runner: unified
 * AbortSignal + timeout lifecycle, parallel bounded stdout/stderr drain, Windows
 * taskkill /POSIX group tree kill, post-exit drain budget and per-call cleanup
 * (port of `Core/Tools/ProcessRunner.cs` at 09f4e08 + P4-win-process-probe).
 */

export const PROCESS_DRAIN_BUDGET_MS = 1000; // C# DrainTimeoutMs
export const PROCESS_KILL_BUDGET_MS = 5000; // P4-win-process-probe close-after-kill budget

export interface ProcessRunOptions {
  /** Working directory (spawn cwd). */
  readonly cwd?: string;
  /** Extra environment variables, merged over the parent environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Tool timeout in milliseconds; undefined = no timeout. */
  readonly timeoutMs?: number;
  /** External cancellation; aborting propagates AbortError and kills the tree. */
  readonly signal?: AbortSignal;
  /** Pin the output decoder label (e.g. "utf-8"); undefined = smart decode. */
  readonly outputEncoding?: string;
  /** Spawn stdio config; default [ignore, pipe, pipe]. */
  readonly stdio?: unknown;
  /** Drain budget after a natural exit, ms (default 1000). */
  readonly drainBudgetMs?: number;
  /** Budget to await process close after a tree kill, ms (default 5000). */
  readonly killBudgetMs?: number;
  /** Override the OEM code page used for non-UTF-8 decode (undefined = auto-discover). */
  readonly oemCodePage?: number;
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

/** Execute one process; resolves with the bounded output result. (Scaffold: no-op.) */
export async function runProcess(
  _file: string,
  _args: readonly string[],
  _options: ProcessRunOptions = {},
): Promise<ProcessResult> {
  return new ProcessResult(0, "", null);
}
