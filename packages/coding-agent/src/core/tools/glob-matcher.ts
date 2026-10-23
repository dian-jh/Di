/*
 * Minimal glob → regex matcher.
 *
 * Semantics ported exactly from:
 * - `*` matches any segment within the same directory level
 * - `?` matches exactly one character
 * - `**` matches across directories
 * - `**` followed by `/` matches zero or more directory levels (so the
 * double-star-slash pattern also hits root-level files)
 * - Paths are always matched with `/` separators; a backslash in the pattern is
 * normalized to `/` (a model writing Windows-style patterns still matches)
 *
 * Everything else is matched literally: regex metacharacters are escaped. Case
 * folding for Windows uses plain JS `i` (Unicode case folding, not
 * locale-sensitive (see `docs/modules/tools.md`).
 */

/** Translate a glob pattern into an anchored RegExp for matching relative paths. */
export function globToRegex(
  pattern: string,
  ignoreCase: boolean,
  normalizeBackslashes = process.platform === "win32",
): RegExp {
  const normalized = normalizeBackslashes ? pattern.replace(/\\/g, "/") : pattern;
  let source = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const c = normalized[i]!; // i < length, so the element always exists
    if (c === "*") {
      if (i + 1 < normalized.length && normalized[i + 1] === "*") {
        i += 1;
        if (i + 1 < normalized.length && normalized[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (c === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExpChar(c);
    }
  }
  source += "$";
  return new RegExp(source, ignoreCase ? "i" : "");
}

/** True when `path` (with `/` separators) matches `pattern`. */
export function globIsMatch(
  pattern: string,
  path: string,
  ignoreCase: boolean,
  normalizeBackslashes = process.platform === "win32",
): boolean {
  return globToRegex(pattern, ignoreCase, normalizeBackslashes).test(path);
}

/** Escape one regex metacharacter (Regex.Escape for the pattern's literal chars). */
function escapeRegExpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}
