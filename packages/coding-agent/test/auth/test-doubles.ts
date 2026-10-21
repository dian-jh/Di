import type { AclAdapter, LockHandle, LockProvider } from "@di/coding-agent";

/**
 * P8b test doubles.
 *
 * The store transaction (lock → re-read inside lock → refresh → validate → atomic
 * replace) is verified with a MOCKED lock: an in-process mutual-exclusion stand-in
 * for the real OS advisory lock. It serializes acquires (a handle is granted only
 * after every earlier holder releases), which is exactly the cross-process
 * guarantee the C# baseline gets from `FileShare.None` and the real lock adapter
 * would provide via LockFileEx / flock. The default FAIL_CLOSED_LOCK_PROVIDER is
 * never used here — these doubles make the seam observable.
 */

export interface MockLockProvider extends LockProvider {
  /** Total acquire() calls since creation. */
  readonly acquireCalls: number;
  /** True while at least one handle is held. */
  readonly isHeld: () => boolean;
}

export function mockLockProvider(): MockLockProvider {
  let tail: Promise<unknown> = Promise.resolve();
  let held = 0;
  const state = { acquireCalls: 0 };
  return {
    get acquireCalls() {
      return state.acquireCalls;
    },
    isHeld: () => held > 0,
    acquire: async (_path: string, opts?: { signal?: AbortSignal }): Promise<LockHandle> => {
      state.acquireCalls++;
      if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      let release: () => void = () => {};
      const gate = new Promise<void>((res) => {
        release = res;
      });
      const prev = tail;
      tail = prev.then(() => gate);
      await prev;
      held++;
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          held--;
          release();
        },
      };
    },
  };
}

/** ACL adapter that applies nothing and never fails (fast store transaction tests). */
export const noopAcl: AclAdapter = {
  async secureDirectory() {},
  async secureFile() {},
};

export interface RecordingAcl extends AclAdapter {
  readonly calls: ReadonlyArray<{ op: "dir" | "file"; path: string }>;
}

/** Records every secureDirectory/secureFile call so tests can assert the store used the seam. */
export function recordingAcl(): RecordingAcl {
  const calls: { op: "dir" | "file"; path: string }[] = [];
  return {
    calls,
    async secureDirectory(path) {
      calls.push({ op: "dir", path });
    },
    async secureFile(path) {
      calls.push({ op: "file", path });
    },
  };
}

/** ACL that secures the directory but refuses the file (fail-closed token-write path). */
export function failingFileAcl(error: Error): AclAdapter {
  return {
    async secureDirectory() {},
    async secureFile() {
      throw error;
    },
  };
}
