/** Shared fs/error classification helpers for the tool modules. */

/** True when `error` is an Error carrying the given `errno`-style code. */
export function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** Human-readable message for an unknown thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
