/*
 *.NET -> JS regex bridging for grep's shorthand classes (-regex-unicode-
 * conformance). Used only by grep (grep.ts); see tools-and-platform.md §
 * ".NET 与 JavaScript 搜索语义差异" (`\w`/`\b`/大小写忽略 row) and
 * §对照表 A.
 *
 * compiles with `RegexOptions.CultureInvariant`, so
 * `\w`/`\d`/`\b` follow Unicode semantics, while JS `\w`/`\d`/`\b` are ASCII-only
 * even under the `u` flag. This module rewrites the.NET shorthand classes to
 * Unicode-aware JS equivalents (the caller still sets `u`):
 *
 * - `\w` -> `[\p{L}\p{Mn}\p{Nd}\p{Pc}_]`. This is the empirically verified.NET
 * `\w` (matching CJK, fullwidth letters, combining marks Mn and connector
 * punctuation Pc; deliberately NOT `\p{N}`/`\p{M}`, which would wrongly match
 * Nl/No numbers like Ⅻ/² and Mc/Me marks).
 * - `\d` -> `\p{Nd}` (.NET decimal digits; matches e.g. U+0663 Arabic-Indic).
 * - `\b` -> lookaround equivalent `(?:(?<!word)(?=word)|(?<=word)(?!word))`,
 * `\B` -> its complement. Fixed-width lookarounds only: no new backtracking
 * blowup is introduced, and the pattern still runs inside a worker that can be
 * terminated ( §超时终止实验).
 * - Negations `\W`/`\D` and in-class uses `[\w]`/`[\d]`/`[\W]`/`[\D]` are
 * bridged too. A class containing `\W`/`\D` is `body ∪ ¬word`/`body ∪ ¬Nd`
 * (or, negated, `word ∩ ¬body`/`Nd ∩ ¬body`), rewritten as an alternation /
 * negative-lookahead since JS cannot negate a class escape inside a class.
 * - `[\b]` inside a class stays the backspace escape (both engines agree);
 * `[\B]` inside a class is left untouched so JS rejects it like.NET does.
 *
 * Only these escapes are rewritten; every other token passes through unchanged.
 * `\A`/`\z`/`\Z` anchor bridging is also handled here (previously translateAnchors).
 * Backslash runs are preserved: `\\w` (even count) stays a literal backslash + w.
 */

/** Unicode word-class body:.NET `\w` = `\p{L}\p{Mn}\p{Nd}\p{Pc}_`. */
const WORD_BODY = String.raw`\p{L}\p{Mn}\p{Nd}\p{Pc}_`;
/** Single-char word class. */
const WORD_CLASS = String.raw`[${WORD_BODY}]`;
/** Single-char non-word class. */
const NON_WORD_CLASS = String.raw`[^${WORD_BODY}]`;
/** .NET `\b` as a fixed-width lookaround (position between word and non-word). */
const WORD_BOUNDARY = String.raw`(?:(?<!${WORD_CLASS})(?=${WORD_CLASS})|(?<=${WORD_CLASS})(?!${WORD_CLASS}))`;
/** .NET `\B` as a fixed-width lookaround (position with equal word-ness both sides). */
const NON_WORD_BOUNDARY = String.raw`(?:(?<=${WORD_CLASS})(?=${WORD_CLASS})|(?<!${WORD_CLASS})(?!${WORD_CLASS}))`;

/**
 * Translate a .NET regex pattern to its JS `u`-flag equivalent, rewriting only
 * `\w`/`\W`/`\d`/`\D`/`\b`/`\B` and the `\A`/`\z`/`\Z` anchors. Invalid .NET or
 * unsupported syntax is left untouched so the caller's `new RegExp(...)` still
 * surfaces it as an explicit error rather than a silent empty result.
 */
export function translateDotNetRegex(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "[") {
      const cls = translateCharacterClass(pattern, i);
      out += cls.text;
      i = cls.end;
      continue;
    }
    if (c !== "\\") {
      out += c;
      i += 1;
      continue;
    }
    // Backslash run: only the last backslash of an odd run is a live escape.
    let j = i;
    while (j < pattern.length && pattern[j] === "\\") j += 1;
    const backslashCount = j - i;
    const next = pattern[j];
    if (backslashCount % 2 === 1 && next !== undefined) {
      out += "\\".repeat(backslashCount - 1);
      switch (next) {
        case "w": out += WORD_CLASS; break;
        case "W": out += NON_WORD_CLASS; break;
        case "d": out += String.raw`\p{Nd}`; break;
        case "D": out += String.raw`[^\p{Nd}]`; break;
        case "b": out += WORD_BOUNDARY; break;
        case "B": out += NON_WORD_BOUNDARY; break;
        case "A": out += "^"; break;
        case "z":
        case "Z": out += "$"; break;
        default: out += `\\${next}`; break;
      }
      i = j + 1;
      continue;
    }
    out += "\\".repeat(backslashCount);
    i = j;
  }
  return out;
}

/** Result of translating a character class starting at `startIndex` (a `[`). */
interface CharacterClassTranslation {
  readonly text: string;
  readonly end: number;
}

/**
 * Translate one `[...]` character class: rewrite `\w`->word body, `\d`->`\p{Nd}`,
 * leave `[\b]` (backspace) untouched, and rewrite a class that contains `\W`/`\D`
 * since JS cannot negate a class escape inside a class. A non-negated class is
 * `body ∪ ¬target` (target = word or Nd), emitted as `(?:[body]|[^target])`
 * (or `[^target]` when the body is empty); a negated class is `target ∩ ¬body`,
 * emitted as `(?![body])[target]`. A `]` as the first content character is a
 * literal (JS class rule), so the class is not closed early.
 */
function translateCharacterClass(pattern: string, startIndex: number): CharacterClassTranslation {
  let body = "";
  let negated = false;
  let i = startIndex + 1;
  if (pattern[i] === "^") {
    negated = true;
    i += 1;
  }
  let firstContent = true;
  let hasWordNegation = false;
  let hasDigitNegation = false;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "]" && !firstContent) {
      return { text: buildCharacterClass(body, negated, hasWordNegation, hasDigitNegation), end: i + 1 };
    }
    if (c !== "\\") {
      body += c;
      i += 1;
      firstContent = false;
      continue;
    }
    let j = i;
    while (j < pattern.length && pattern[j] === "\\") j += 1;
    const backslashCount = j - i;
    const next = pattern[j];
    if (backslashCount % 2 === 1 && next !== undefined) {
      body += "\\".repeat(backslashCount - 1);
      if (next === "w") body += WORD_BODY;
      else if (next === "d") body += String.raw`\p{Nd}`;
      else if (next === "W") hasWordNegation = true;
      else if (next === "D") hasDigitNegation = true;
      else body += `\\${next}`; // \b (backspace), \s, \p{...}, escapes — verbatim
      i = j + 1;
    } else {
      body += "\\".repeat(backslashCount);
      i = j;
    }
    firstContent = false;
  }
  // Unterminated class: emit verbatim; the caller's `new RegExp` reports the error.
  return { text: `[${negated ? "^" : ""}${body}`, end: i };
}

function buildCharacterClass(
  body: string,
  negated: boolean,
  hasWordNegation: boolean,
  hasDigitNegation: boolean,
): string {
  const target = hasDigitNegation ? String.raw`\p{Nd}` : WORD_BODY;
  const positiveTarget = `[${target}]`;
  const negativeTarget = `[^${target}]`;
  if (!hasWordNegation && !hasDigitNegation) {
    return `[${negated ? "^" : ""}${body}]`;
  }
  // Wrap the remaining body as a positive class; a leading literal `^` must be
  // escaped (`[^...]` would negate the whole class, e.g. `[^^\W]` = W \ {^}).
  const bodyClass = body.startsWith("^") ? `[\\^${body.slice(1)}]` : `[${body}]`;
  if (negated) {
    // .NET `[^C\W]` = ¬(C ∪ ¬target) = target ∩ ¬C  ->  (?!C)[target]
    if (body === "") return positiveTarget;
    return `(?!${bodyClass})${positiveTarget}`;
  }
  // .NET `[C\W]` = C ∪ ¬target
  if (body === "") return negativeTarget;
  return `(?:${bodyClass}|${negativeTarget})`;
}
