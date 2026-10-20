import type { Skill } from "./skill.ts";

/**
 * Skill matcher — the "auto activation" seam deciding which skills a user
 * message should auto-load (semantic relevance of the message against each
 * skill's name + description). This is the replaceable seam: the current
 * implementation is an offline lexical matcher (no dependencies, deterministic,
 * testable); an embedding-based matcher can swap in later without callers or the
 * loop noticing.
 *
 * Mirrors `Core/Skills/SkillMatcher.cs` at baseline 09f4e08:
 * - ASCII tokenization `[A-Za-z0-9]+`, lowercased, dropping words shorter than
 *   2 chars and the English stopword list (Ordinal set);
 * - Chinese adjacent-character bigrams over CJK U+4E00..U+9FFF (no
 *   segmentation dependency);
 * - overlap coefficient = |query ∩ skill| / min(|query|, |skill|) so neither a
 *   long query nor a long description is diluted;
 * - relevance threshold 0.30, at most 3 matches;
 * - equal scores tie-broken by name with Ordinal (UTF-16 code-unit) comparison,
 *   NOT locale ordering.
 */

/** One skill match (skill + relevance). */
export interface SkillMatch {
  readonly skill: Skill;
  readonly relevance: number;
}

/** Injectable auto-activation seam (a future embedding implementation swaps in here). */
export interface ISkillMatcher {
  /** Matches above the threshold, ordered by relevance descending, capped. */
  match(userMessage: string, skills: readonly Skill[]): readonly SkillMatch[];
}

const STOP_WORDS = new Set<string>([
  "the", "a", "an", "is", "are", "was", "to", "for", "of", "on", "in", "with", "and", "or",
  "this", "that", "my", "your", "me", "please", "help", "do", "does", "can", "how", "what",
]);

const CJK_START = 0x4e00;
const CJK_END = 0x9fff;
const ASCII_WORD = /[A-Za-z0-9]+/g;

export interface LexicalSkillMatcherOptions {
  /** Minimum relevance (query overlap, 0..1). Default 0.30. */
  readonly minRelevance?: number;
  /** Max auto-activations per message. Default 3. */
  readonly maxMatches?: number;
}

/**
 * Lexical matcher: tokenizes the user message and each skill's name + description
 * (ASCII words + Chinese bigrams) and scores with the overlap coefficient.
 * Lightweight, offline, deterministic and testable; weaker than an embedding
 * approach at paraphrase matching (that is the documented upgrade path).
 */
export class LexicalSkillMatcher implements ISkillMatcher {
  readonly minRelevance: number;
  readonly maxMatches: number;

  constructor(options?: LexicalSkillMatcherOptions) {
    this.minRelevance = options?.minRelevance ?? 0.3;
    this.maxMatches = options?.maxMatches ?? 3;
  }

  match(userMessage: string, skills: readonly Skill[]): readonly SkillMatch[] {
    if (userMessage == null || typeof userMessage !== "string" || userMessage.trim().length === 0) return [];
    if (skills == null || skills.length === 0) return [];

    const msgTokens = tokenize(userMessage);
    if (msgTokens.size === 0) return [];

    const matches: SkillMatch[] = [];
    for (const skill of skills) {
      // disable-model-invocation skills accept only explicit /skill calls, never auto-match.
      if (skill.disableModelInvocation) continue;
      const skillTokens = tokenize(`${skill.name} ${skill.description}`);
      const relevance = overlapCoefficient(msgTokens, skillTokens);
      if (relevance >= this.minRelevance) matches.push({ skill, relevance });
    }

    matches.sort((a, b) => {
      if (a.relevance !== b.relevance) return b.relevance - a.relevance;
      return ordinalCompare(a.skill.name, b.skill.name);
    });
    return matches.slice(0, this.maxMatches);
  }
}

/** Tokenize: ASCII words (lowercased, stopwords / short words dropped) + Chinese bigrams. */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(ASCII_WORD)) {
    const word = match[0].toLowerCase();
    if (word.length < 2 || STOP_WORDS.has(word)) continue;
    tokens.add(word);
  }
  addCjkBigrams(text, tokens);
  return tokens;
}

/**
 * Add adjacent CJK character bigrams (range U+4E00..U+9FFF); any other character
 * breaks the run (C# `SkillMatcher.AddCjkBigrams` over `char`).
 */
function addCjkBigrams(text: string, tokens: Set<string>): void {
  let prev = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= CJK_START && code <= CJK_END) {
      if (prev !== "") tokens.add(prev + ch);
      prev = ch;
    } else {
      prev = "";
    }
  }
}

/**
 * Overlap coefficient = |query ∩ skill| / min(|query|, |skill|): neither side is
 * diluted. With the shorter side as denominator, filler-heavy conversational
 * messages and long descriptions no longer push relevance below the threshold.
 */
function overlapCoefficient(query: Set<string>, skill: Set<string>): number {
  if (query.size === 0 || skill.size === 0) return 0;
  let overlap = 0;
  for (const token of query) {
    if (skill.has(token)) overlap += 1;
  }
  return overlap / Math.min(query.size, skill.size);
}

/** Ordinal (UTF-16 code-unit) comparison — C# `StringComparer.Ordinal`, NOT locale. */
function ordinalCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
