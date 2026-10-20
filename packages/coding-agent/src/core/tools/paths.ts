import { resolve } from "node:path";

/**
 * Resolve a (possibly relative) tool path against the workspace base directory.
 * Mirrors `Core/Tools/ToolHelpers.ResolvePath`: `Path.Combine(base, path)` +
 * `Path.GetFullPath`. Absolute paths and `..` are allowed (no sandbox rejection
 * rules are added, per tools-and-platform.md). `path.resolve` normalizes `/`
 * and `\` on Windows and `/` elsewhere, like .NET does.
 */
export function resolvePath(baseDirectory: string, path: string): string {
  return resolve(baseDirectory, path);
}
