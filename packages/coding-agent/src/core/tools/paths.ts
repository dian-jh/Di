import { resolve, sep } from "node:path";

/** Use slash separators in tool results without changing legal filename characters. */
export function normalizeToolPath(path: string, separator = sep): string {
  return path.split(separator).join("/");
}

/*
 * Resolve a (possibly relative) tool path against the workspace base directory.
 *: `Path.Combine(base, path)` +
 * `Path.GetFullPath`. Absolute paths and `..` are allowed (no sandbox rejection
 * rules are added (see `docs/modules/tools.md`). `path.resolve` normalizes `/`
 * and `\` on Windows and `/` elsewhere, like.NET does.
 */
export function resolvePath(baseDirectory: string, path: string): string {
  return resolve(baseDirectory, path);
}

/*
 * True when the path contains a character that can never appear in a filesystem
 * path (`Path.GetInvalidPathChars` — NUL on every platform, plus control
 * chars 0x00–0x1F on Windows).
 */
export function hasIllegalPathChars(p: string): boolean {
  if (p.includes("\0")) return true;
  if (process.platform !== "win32") return false;
  for (let i = 0; i < p.length; i += 1) {
    if (p.charCodeAt(i) < 32) return true;
  }
  return false;
}
