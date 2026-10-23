import { createRequire } from "node:module";
import { mkdir, open as fsOpen } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";

/*
 * Cross-process OS advisory lock seam for CredentialStore transactions.
 * `NativeOsLockProvider` holds LockFileEx (Windows) or flock (POSIX) across the
 * complete read/refresh/commit transaction. Kernel handle release after process
 * termination prevents stale lock files from acting as ownership markers.
 * Missing native support, permission errors, timeout, and cancellation fail
 * closed; the store does not refresh or replace credentials without the lock.
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
  /*
 * Acquire a cross-process exclusive lock scoped to `path`.
 *
 * The returned handle is held across the ENTIRE transaction (read, refresh,
 * commit). Failures must be recoverable errors that preserve credentials.
 */
  acquire(path: string, opts?: LockAcquireOptions): Promise<LockHandle>;
}

/** Real kernel advisory lock: LockFileEx on Windows and flock on POSIX. */
export class NativeOsLockProvider implements LockProvider {
  private readonly retryDelayMs: number;
  private readonly defaultTimeoutMs: number;

  constructor(options: { retryDelayMs?: number; timeoutMs?: number } = {}) {
    this.retryDelayMs = options.retryDelayMs ?? 50;
    this.defaultTimeoutMs = options.timeoutMs ?? 30_000;
  }

  async acquire(path: string, opts: LockAcquireOptions = {}): Promise<LockHandle> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const started = Date.now();
    try {
      await mkdir(dirname(path), { recursive: true });
    } catch (error) {
      throw new LockUnavailableError(`Cannot prepare OS lock directory: ${message(error)}`, { cause: error });
    }
    if (process.platform === "win32") return this.acquireWindows(path, started, timeoutMs, opts.signal);
    if (["linux", "darwin", "freebsd", "openbsd"].includes(process.platform)) {
      return this.acquirePosix(path, started, timeoutMs, opts.signal);
    }
    throw new LockUnavailableError(`OS advisory locks are unsupported on ${process.platform}.`);
  }

  private async acquireWindows(path: string, started: number, timeoutMs: number, signal?: AbortSignal): Promise<LockHandle> {
    const api = windowsApi();
    const handle = api.create(path, 0xc0000000, 7, null, 4, 0x80, null);
    const invalidHandle = BigInt.asUintN(process.arch === "ia32" ? 32 : 64, -1n);
    if (handle === null || api.koffi.address(handle) === invalidHandle) {
      throw new LockUnavailableError(`Cannot open the OS lock file (${api.getLastError()}).`);
    }
    const ov = { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: null };
    try {
      for (;;) {
        if (signal?.aborted) throw new LockUnavailableError("Waiting for the OS lock was cancelled.");
        if (api.lock(handle, 3, 0, 0xffffffff, 0xffffffff, ov)) {
          let released = false;
          return { release: async () => {
            if (released) return;
            released = true;
            try { if (!api.unlock(handle, 0, 0xffffffff, 0xffffffff, ov)) throw new Error(`UnlockFileEx failed (${api.getLastError()}).`); }
            finally { api.close(handle); }
          } };
        }
        const code = api.getLastError();
        if (code !== 33 && code !== 158) throw new LockUnavailableError(`LockFileEx failed (${code}).`);
        await this.wait(path, started, timeoutMs, signal);
      }
    } catch (error) {
      api.close(handle);
      if (error instanceof LockUnavailableError) throw error;
      throw new LockUnavailableError(`Cannot acquire OS lock: ${message(error)}`, { cause: error });
    }
  }

  private async acquirePosix(path: string, started: number, timeoutMs: number, signal?: AbortSignal): Promise<LockHandle> {
    const api = posixApi();
    let file: import("node:fs/promises").FileHandle;
    try {
      file = await fsOpen(path, fsConstants.O_CREAT | fsConstants.O_RDWR, 0o600);
    } catch (error) {
      throw new LockUnavailableError(`Cannot open OS lock file: ${message(error)}`, { cause: error });
    }
    const fd = file.fd;
    try {
      for (;;) {
        if (signal?.aborted) throw new LockUnavailableError("Waiting for the OS lock was cancelled.");
        if (api.flock(fd, 2 | 4) === 0) { // LOCK_EX | LOCK_NB
          let released = false;
          return { release: async () => {
            if (released) return;
            released = true;
            try { if (api.flock(fd, 8) !== 0) throw new Error(`flock unlock failed (errno ${api.koffi.errno()}).`); }
            finally { await file.close(); }
          } };
        }
        const errno = api.koffi.errno();
        if (errno !== 11 && errno !== 35) throw new LockUnavailableError(`flock failed (errno ${errno}).`);
        await this.wait(path, started, timeoutMs, signal);
      }
    } catch (error) {
      await file.close();
      if (error instanceof LockUnavailableError) throw error;
      throw new LockUnavailableError(`Cannot acquire OS lock: ${message(error)}`, { cause: error });
    }
  }

  private async wait(path: string, started: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (Date.now() - started >= timeoutMs) throw new LockUnavailableError(`Timed out waiting for OS lock ${path}.`);
    if (signal?.aborted) throw new LockUnavailableError("Waiting for the OS lock was cancelled.");
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(), this.retryDelayMs);
      const abort = (): void => finish(new LockUnavailableError("Waiting for the OS lock was cancelled."));
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function getKoffi(): typeof import("koffi") {
  try {
    return createRequire(import.meta.url)("koffi") as typeof import("koffi");
  } catch (error) {
    throw new LockUnavailableError(`Native OS lock provider is unavailable: ${message(error)}`, { cause: error });
  }
}

interface WindowsApi {
  readonly koffi: typeof import("koffi");
  readonly create: (path: string, access: number, share: number, security: null, creation: number, flags: number, template: null) => unknown;
  readonly lock: (handle: unknown, flags: number, reserved: number, low: number, high: number, overlapped: object) => number;
  readonly unlock: (handle: unknown, reserved: number, low: number, high: number, overlapped: object) => number;
  readonly close: (handle: unknown) => number;
  readonly getLastError: () => number;
}
interface PosixApi { readonly koffi: typeof import("koffi"); readonly flock: (fd: number, operation: number) => number }
let cachedWindowsApi: WindowsApi | undefined;
let cachedPosixApi: PosixApi | undefined;

function windowsApi(): NonNullable<typeof cachedWindowsApi> {
  if (cachedWindowsApi !== undefined) return cachedWindowsApi;
  try {
    const koffi = getKoffi();
    const kernel = koffi.load("kernel32.dll");
    const overlappedType = koffi.struct("DI_OVERLAPPED", {
      Internal: "uintptr_t", InternalHigh: "uintptr_t", Offset: "uint32_t", OffsetHigh: "uint32_t", hEvent: "void *",
    });
    const ptr = koffi.pointer(overlappedType);
    cachedWindowsApi = {
      koffi,
      create: kernel.func("void * __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, void *template)") as unknown as WindowsApi["create"],
      lock: kernel.func("__stdcall", "LockFileEx", "int", ["void *", "uint32_t", "uint32_t", "uint32_t", "uint32_t", ptr]) as unknown as WindowsApi["lock"],
      unlock: kernel.func("__stdcall", "UnlockFileEx", "int", ["void *", "uint32_t", "uint32_t", "uint32_t", ptr]) as unknown as WindowsApi["unlock"],
      close: kernel.func("int __stdcall CloseHandle(void *h)") as unknown as WindowsApi["close"],
      getLastError: kernel.func("uint32_t __stdcall GetLastError(void)") as unknown as WindowsApi["getLastError"],
    };
    return cachedWindowsApi;
  } catch (error) {
    throw new LockUnavailableError(`Windows OS lock provider is unavailable: ${message(error)}`, { cause: error });
  }
}

function posixApi(): NonNullable<typeof cachedPosixApi> {
  if (cachedPosixApi !== undefined) return cachedPosixApi;
  try {
    const koffi = getKoffi();
    const libcName = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : process.platform === "freebsd" ? "libc.so.7" : process.platform === "openbsd" ? "libc.so" : "libc.so.6";
    const libc = koffi.load(libcName);
    cachedPosixApi = {
      koffi,
      flock: libc.func("int flock(int fd, int operation)") as unknown as PosixApi["flock"],
    };
    return cachedPosixApi;
  } catch (error) {
    throw new LockUnavailableError(`POSIX OS lock provider is unavailable: ${message(error)}`, { cause: error });
  }
}

/**
 * Explicit fail-closed provider for environments that cannot enable native locks.
 * When selected, every acquire rejects with a recoverable error; credentials
 * credentials are preserved and the store never runs unlocked.
 */
export const FAIL_CLOSED_LOCK_PROVIDER: LockProvider = {
  async acquire(_path: string, _opts?: LockAcquireOptions): Promise<LockHandle> {
    throw new LockUnavailableError(
      "无法取得跨进程凭据锁：无真实 OS advisory lock 适配器，已失败关闭（凭据已保留，未解锁继续）。",
    );
  },
};
