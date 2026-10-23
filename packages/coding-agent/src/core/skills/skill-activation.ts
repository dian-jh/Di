import type { Skill } from "./skill.ts";
import type { ISkillMatcher } from "./skill-matcher.ts";

/*
 * Shared skill activation computation — the ONE pure function every mode
 * (REPL / print / JSON / RPC) uses to turn a message + the available skills into
 * the turn's active set: pinned skills come first, auto-matched
 * skills are appended after them (deduped against the pinned set by name), and
 * the whole set is recomputed per turn — never accumulated.
 */

/** One turn's activation: the fixed (pinned) set plus the fresh auto-match. */
export interface SkillActivationResult {
  /** Pinned skills first, then auto-matched (deduped, pinned excluded). */
  readonly active: readonly Skill[];
  /** The skills the matcher auto-matched this turn (never includes a pinned skill). */
  readonly autoMatched: readonly Skill[];
}

/*
 * Compute the activation set for a user message. Pure and deterministic: the
 * same (message, allSkills, pinned, matcher) always yields the same result, and
 * no state carries across calls — every turn recomputes from scratch. The host
 * injects `result.active` at the turn boundary;
 * `AgentSession.setActiveSkills` is already a turn-boundary read that keeps the
 * body in the volatile request tail.
 */
export function computeSkillActivation(
  userMessage: string,
  allSkills: readonly Skill[],
  pinned: readonly Skill[],
  matcher: ISkillMatcher,
): SkillActivationResult {
  if (allSkills == null) throw new TypeError("computeSkillActivation: allSkills is required");
  if (pinned == null) throw new TypeError("computeSkillActivation: pinned is required");
  if (matcher == null) throw new TypeError("computeSkillActivation: matcher is required");

  // Name is the repository's unique identity (loadSkills dedupes by name), so a
  // pinned skill is excluded from the auto set by name — mirroring record
  // value-equality on the same-name skill while staying reference-independent.
  const pinnedNames = new Set(pinned.map((s) => s.name));
  const autoMatched = matcher
    .match(userMessage, allSkills)
    .filter((m) => !pinnedNames.has(m.skill.name))
    .map((m) => m.skill);
  return { active: [...pinned, ...autoMatched], autoMatched };
}
