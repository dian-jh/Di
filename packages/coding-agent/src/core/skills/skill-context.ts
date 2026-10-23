import type { Skill } from "./skill.ts";

/**
 * Renders skill advertisements and active skill instructions for a model turn.
 * (progressive disclosure, the "Advertise" phase): each available skill is
 * advertised as one `- name：description` line (~100 tokens/skill) while the full
 * instructions stay out of the resident context and are loaded on demand via
 * load_skill. The advertisement and the activation body are SEPARATE; the body is
 * what enters the volatile system context (the request tail) — it never becomes
 * persistent history.
 */

/*
 * Advertisement block: one `- name：description` line per skill so the model knows
 * what is available (the load_skill candidate list). `disable-model-invocation`
 * skills are excluded (they accept only explicit /skill calls).
 */
export function buildAdvertisement(skills: readonly Skill[]): string {
  return skills
    .filter((s) => !s.disableModelInvocation)
    .map((s) => `- ${s.name}：${s.description}`)
    .join("\n");
}

/**
 * Estimate the per-turn token cost added by skills: the advertisement of the
 * inactive skills plus the full
 * instructions of the active ones. Roughly 4 chars/token; used for the context
 * instructions of active skills.
 */
export function estimateSkillTokens(skills: readonly Skill[], activeNames: readonly string[]): number {
  const active = new Set(activeNames);
  const inactive = skills.filter((s) => !active.has(s.name));
  let chars = buildAdvertisement(inactive).length;
  for (const skill of skills) {
    if (active.has(skill.name)) chars += skill.name.length + skill.instructions.length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Assemble the skill system context: the
 * advertisement of the skills that are NOT active, then the activation body (full
 * instructions) of the active skills, joined by a blank line. Returns `undefined`
 * when there is nothing to disclose. This is the pure computation a host feeds
 * into the volatile request tail (`SessionTurnOptions.systemContext` or
 * `AgentSession.setActiveSkills`); it never writes to history.
 */
export function buildSkillSystemContext(
  skills: readonly Skill[],
  activeSkills: readonly Skill[],
): string | undefined {
  const activeNames = new Set(activeSkills.map((s) => s.name));
  const advertised = skills.filter((s) => !activeNames.has(s.name));
  const parts: string[] = [];
  if (advertised.length > 0) {
    parts.push("可用 skills（需要时用 load_skill 加载完整指令）：\n" + buildAdvertisement(advertised));
  }
  if (activeSkills.length > 0) {
    parts.push(activeSkills.map((s) => `【已激活 Skill：${s.name}】\n${s.instructions}`).join("\n\n"));
  }
  return parts.length === 0 ? undefined : parts.join("\n\n");
}
