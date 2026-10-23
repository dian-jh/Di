import type { ISkillMatcher } from "./skill-matcher.ts";
import type { Skill } from "./skill.ts";
import { estimateSkillTokens } from "./skill-context.ts";
import type { SkillTestCase } from "./skill-case-loader.ts";

/*
 * Matcher quality/cost metrics over a labeled case set. Three acceptance classes:
 * - trigger tests = cases whose `expectedSkills` is non-empty and are hit by the
 * matcher (they contribute to precision / recall);
 * - exclusion tests = cases whose `expectedSkills` is empty and must NOT be hit
 * (they contribute to the no-match rate);
 * - execution tests = beyond the matcher's scope, verified by each skill's own
 * workflow.
 */

/** Quality and context-cost metrics for one matcher run over a case set. */
export interface SkillMetrics {
  /** Precision: of the activated skills, how many were actually wanted. */
  readonly precision: number;
  /** Recall: of the wanted skills, how many were successfully selected. */
  readonly recall: number;
  /** No-match rate: how many tasks matched no skill at all. */
  readonly noMatchRate: number;
  /** Context cost: average estimated skill-related tokens per turn. */
  readonly averageContextTokens: number;
}

/*
 * Evaluate the matcher over the labeled cases (`SkillEvaluator.Evaluate`).
 * Activated/wanted sets use the matched skill names; the context cost uses
 * `estimateSkillTokens` with the activated names (the same estimate the
 * production context injection uses).
 */
export function evaluateSkillSet(
  matcher: ISkillMatcher,
  skills: readonly Skill[],
  cases: readonly SkillTestCase[],
): SkillMetrics {
  let activated = 0;
  let correct = 0;
  let expected = 0;
  let noMatch = 0;
  let contextTokens = 0;

  for (const tc of cases) {
    const hit = new Set(matcher.match(tc.message, skills).map((m) => m.skill.name));
    const want = new Set(tc.expectedSkills);
    activated += hit.size;
    for (const name of hit) if (want.has(name)) correct += 1;
    expected += want.size;
    if (hit.size === 0) noMatch += 1;
    contextTokens += estimateSkillTokens(skills, [...hit]);
  }

  return {
    precision: activated === 0 ? 0 : correct / activated,
    recall: expected === 0 ? 0 : correct / expected,
    noMatchRate: cases.length === 0 ? 0 : noMatch / cases.length,
    averageContextTokens: cases.length === 0 ? 0 : contextTokens / cases.length,
  };
}
