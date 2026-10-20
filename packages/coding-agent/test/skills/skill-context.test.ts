import test from "node:test";
import assert from "node:assert/strict";

import type { Skill } from "@di/coding-agent";
import { buildAdvertisement, buildSkillSystemContext, estimateSkillTokens } from "@di/coding-agent";

/**
 * P6.2b unit 6 — disclosure (advertise phase). Mirrors `Core/Skills/SkillContext.cs`
 * at baseline 09f4e08 plus the system-context assembly in `AgentRunner.RunAsync`:
 * the advertisement (one `- name：description` line per available skill) and the
 * activation body (full instructions of the active skills) are SEPARATE; the body
 * is what enters the volatile system context (the request tail) — never
 * persistent history. `disable-model-invocation` skills are excluded from the ad.
 */

function skill(name: string, description: string, instructions: string, overrides?: Partial<Skill>): Skill {
  return {
    name,
    description,
    instructions,
    metadata: {},
    allowedTools: [],
    disableModelInvocation: false,
    directory: "",
    ...overrides,
  };
}

test("advertisement excludes disabled skills", () => {
  const skills = [
    skill("a", "广告 A", "指令 A"),
    skill("b", "广告 B", "指令 B", { disableModelInvocation: true }),
  ];

  const ad = buildAdvertisement(skills);

  assert.match(ad, /a/);
  assert.doesNotMatch(ad, /b/);
});

test("advertisement carries name and description only, not full instructions", () => {
  const longInstructions = new Array(500).fill("x").join("");
  const s = skill("pdf-tools", "提取 PDF 文本与表格", longInstructions);

  const ad = buildAdvertisement([s]);

  assert.match(ad, /pdf-tools/);
  assert.match(ad, /提取 PDF 文本与表格/);
  assert.ok(!ad.includes(longInstructions.slice(0, 100)), "full instructions must not enter the ad");
});

test("advertisement is one name：description line per skill", () => {
  const skills = [skill("a", "广告 A", "指令 A"), skill("b", "广告 B", "指令 B")];

  assert.equal(buildAdvertisement(skills), "- a：广告 A\n- b：广告 B");
});

test("system context separates advertisement and activation body", () => {
  const a = skill("a", "广告 A", "指令 A 全文");
  const b = skill("b", "广告 B", "指令 B 全文");
  const active = [a];

  const ctx = buildSkillSystemContext([a, b], active);

  assert.ok(ctx !== undefined);
  // Advertisement covers ONLY the not-active skill (name + description).
  assert.match(ctx!, /可用 skills（需要时用 load_skill 加载完整指令）：/);
  assert.match(ctx!, /- b：广告 B/);
  assert.ok(!ctx!.includes("- a：广告 A"), "an active skill is not advertised");
  // Activation body carries the FULL instructions of the active skill.
  assert.match(ctx!, /【已激活 Skill：a】/);
  assert.match(ctx!, /指令 A 全文/);
  // The two parts are separate blocks, not merged into one.
  assert.ok(ctx!.includes("\n\n"), "advertisement and body are separate blocks");
});

test("system context returns undefined when there is nothing to disclose", () => {
  assert.equal(buildSkillSystemContext([], []), undefined);
  // When every available skill is active, nothing is advertised — body only.
  const a = skill("a", "广告 A", "指令 A");
  const ctx = buildSkillSystemContext([a], [a]);
  assert.ok(ctx !== undefined);
  assert.ok(!ctx!.includes("可用 skills"));
  assert.match(ctx!, /【已激活 Skill：a】/);
});

test("estimate skill tokens counts advertisement of inactive and full instructions of active", () => {
  const skills = [skill("a", "广告 A", "指令 A"), skill("b", "广告 B", "指令 B")];

  // No active skills: only the advertisement ("- a：广告 A\n- b：广告 B" = 19 chars)
  // → ceil(19/4) = 5.
  assert.equal(estimateSkillTokens(skills, []), 5);
  // "a" active: advertisement of "b" only ("- b：广告 B" = 9) + name(1) + instructions(3)
  // → ceil(13/4) = 4.
  assert.equal(estimateSkillTokens(skills, ["a"]), 4);
});
