/**
 * Cross-process exclusive lock seam (P8b).
 *
 * The migration contract (docs/migration/typescript-core/models-and-auth.md
 * §"OAuth PKCE、轮换与原子凭据写入") mandates a real OS advisory lock (Windows
 * `LockFileEx` / POSIX `flock`) held across read → network refresh → atomic
 * replace, so two processes can never consume a one-time refresh token. The
 * P8-auth-storage probe proved that no pure-JS cross-platform adapter is
 * acceptable: `proper-lockfile`/`lockfile` use mkdir+TTL staleness (explicitly
 * forbidden) and `fs-ext` needs a native node-gyp build that is not distributed.
 *
 * The CONTRACT-MANDATED default is therefore FAIL CLOSED (models-and-auth.md
 * line ~174): when no real OS-advisory-lock adapter is available, `acquire()`
 * rejects with a recoverable {@link LockUnavailableError}. Credentials are
 * preserved, the store never proceeds unlocked, and stale locks are never
 * auto-recovered by PID/age — stale locks only via an explicit offline manual
 * recovery process. `open('wx')` existence locks are FORBIDDEN here (probe §2:
 * a crashed process leaves the file → permanent deadlock).
 *
 * The seam is DI-injectable: synthetic tests inject a mock lock and verify the
 * transaction logic (lock → re-read → refresh → validate → replace) exactly.
 * The real adapter (a reviewed native wrapper over LockFileEx / flock) is a
 * later optional enhancement and stays OUT of scope for this card.
 */

/** Recoverable failure: the lock could not be acquired and the store must fail closed. */
export class LockUnavailableError extends Error {
  readonly code = "lock-unavailable" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LockUnavailableError";
  }
}

export interface LockAcquireOptions {
  /** Abort waiting for the lock. Never deletes the lock file or the credentials. */
  readonly signal?: AbortSignal;
  /** Upper bound on waiting for the lock, in milliseconds. */
  readonly timeoutMs?: number;
}

export interface LockHandle {
  /** Release the lock. Idempotent; safe to call more than once. */
  release(): Promise<void>;
}

export interface LockProvider {
  /**
   * Acquire a cross-process exclusive lock scoped to `path`.
   *
   * The returned handle is held across the ENTIRE transaction (read, refresh,
   * commit). Failures must be recoverable errors that preserve credentials.
   */
  acquire(path: string, opts?: LockAcquireOptions): Promise<LockHandle>;
}

/**
 * Contract-mandated default: fail closed. No real OS-advisory-lock adapter is
 * approved in this package, so every acquire rejects with a recoverable error —
 * credentials are preserved and the store never runs unlocked.
 */
export const FAIL_CLOSED_LOCK_PROVIDER: LockProvider = {
  async acquire(_path: string, _opts?: LockAcquireOptions): Promise<LockHandle> {
    throw new LockUnavailableError(
      "无法取得跨进程凭据锁：无真实 OS advisory lock 适配器，已失败关闭（凭据已保留，未解锁继续）。",
    );
  },
};
