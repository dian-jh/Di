import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Dirent } from "node:fs";

/**
 * Recursive file enumeration shared by the search tools (glob, later grep).
 *
 * Ported from `Core/Tools/ToolHelpers.EnumerateFiles` at 09f4e08:
 * - directories named like build outputs / dependencies / VCS / caches are
 *   skipped by name (case-insensitive), so a scan of a huge home directory
 *   cannot crawl AppData/Temp/caches forever (2026-10-15 incident regression)
 * - unreadable subdirectories are skipped, never failing the whole walk
 * - symlink/junction subdirectories are not descended into (their cycles would
 *   hang a naive walk); the search root itself may be a symlink and is still
 *   traversed
 * - only files are yielded, never directories
 *
 * The walk is truly async and cancellable: each directory read is an awaited
 * async fs call and `signal` is checked at every boundary, so an abort lands
 * while the scan is running (execution-plan P4 gate: a synchronous scan wrapped
 * in a Promise is NOT acceptable).
 */

/** Directory names excluded by `isExcludedDirectoryName` (C# ExcludedDirectoryNames). */
const EXCLUDED_DIRECTORY_NAMES = new Set([
  "obj",
  "bin",
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".vs",
  ".idea",
  "__pycache__",
  ".venv",
  "venv",
  "appdata",
  "temp",
  "cache",
  "caches",
  ".cache",
]);

/**
 * Case-insensitive check by directory name. Lowercasing is used (not
 * locale-aware uppercasing), mirroring C# `StringComparer.OrdinalIgnoreCase`.
 */
export function isExcludedDirectoryName(name: string): boolean {
  return EXCLUDED_DIRECTORY_NAMES.has(name.toLowerCase());
}

/**
 * Yield the absolute path of every file under `root`, depth-first.
 * `signal` aborts the walk by throwing AbortError at the next boundary.
 */
export async function* enumerateFiles(root: string, signal?: AbortSignal): AsyncGenerator<string> {
  const pending: Array<{ dir: string }> = [{ dir: root }];
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const dir = pending.pop()!.dir;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable or vanished directory → skip, never fail the walk
    }
    signal?.throwIfAborted();

    const subDirs: string[] = [];
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        subDirs.push(child);
      } else if (entry.isFile()) {
        yield child;
      } else if (entry.isSymbolicLink()) {
        // C# GetFiles includes symlink-to-file entries; symlink/junction
        // directories are NOT descended into. Broken links are skipped.
        if (await isSymlinkToFile(child)) yield child;
      }
    }
    for (const sub of subDirs) {
      if (isExcludedDirectoryName(basename(sub))) continue;
      pending.push({ dir: sub });
    }
  }
}

/** Follow a symlink: true when it resolves to a regular file (C# GetFiles). */
async function isSymlinkToFile(path: string): Promise<boolean> {
  try {
    const target = await stat(path); // follows the link
    return target.isFile();
  } catch {
    return false;
  }
}
