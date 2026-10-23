import test from "node:test";
import assert from "node:assert/strict";

import type { Skill } from "@di/coding-agent";
import { LexicalSkillMatcher } from "@di/coding-agent";

/**
 *
 * ASCII `[A-Za-z0-9]+` tokenization with English stopwords, Chinese adjacent-
 * character bigrams (CJK U+4E00..U+9FFF), the overlap coefficient (shorter side
 * as denominator), relevance threshold 0.30, at most 3 matches, and equal scores
 * tie-broken by name with Ordinal (UTF-16 code-unit) comparison — NOT locale.
 */

function skill(name: string, description: string, overrides?: Partial<Skill>): Skill {
  return {
    name,
    description,
    instructions: "instructions",
    metadata: {},
    allowedTools: [],
    disableModelInvocation: false,
    directory: "",
    ...overrides,
  };
}

test("chinese relevant skill is returned", () => {
  const s = skill("backend-tests", "运行并修复后端测试");
  const matcher = new LexicalSkillMatcher();

  const matches = matcher.match("运行测试", [s]);

  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.skill.name, "backend-tests");
  assert.ok(matches[0]!.relevance >= 0.2, `relatedness too low: ${matches[0]!.relevance}`);
});

test("english relevant skill is returned", () => {
  const s = skill("deploy", "Run the backend tests and fix failures");
  const matcher = new LexicalSkillMatcher();

  const matches = matcher.match("run backend tests", [s]);

  assert.equal(matches.length, 1);
});

test("unrelated message returns empty", () => {
  const s = skill("backend-tests", "运行并修复后端测试");
  const matcher = new LexicalSkillMatcher();

  const matches = matcher.match("今天天气不错，随便聊聊", [s]);

  assert.deepEqual(matches, []);
});

test("disabled skill is not auto activated", () => {
  // disable-model-invocation: true 的 skill 只接受显式 /skill 调用，不进自动匹配。
  const s = skill("backend-tests", "运行并修复后端测试", { disableModelInvocation: true });
  const matcher = new LexicalSkillMatcher();

  const matches = matcher.match("运行测试", [s]);

  assert.deepEqual(matches, []);
});

test("respects min relevance threshold", () => {
  const s = skill("backend-tests", "运行并修复后端测试");
  const matcher = new LexicalSkillMatcher({ minRelevance: 0.9 });

  const matches = matcher.match("运行测试", [s]);

  assert.deepEqual(matches, []);
});

test("verbose message with filler still matches (overlap coefficient, not query coverage)", () => {
  // Query coverage would divide by the full 16-bigram query → 3/16 = 0.19 < 0.30
  // and miss. The overlap coefficient divides by min(|Q|,|S|) → 3/9, so the
  // filler-heavy conversational message does NOT dilute a relevant skill away.
  const s = skill("backend-tests", "运行并修复后端测试");
  const matcher = new LexicalSkillMatcher();

  const matches = matcher.match("今天能不能帮我运行一下后端的测试用例", [s]);

  assert.equal(matches.length, 1);
});

test("long description is not diluted", () => {
  // A long description no longer dilutes the score (Dice's known weakness).
  const s = skill("backend-tests", "运行并修复后端测试，包括构建、失败定位与重跑。");
  const matcher = new LexicalSkillMatcher();

  const matches = matcher.match("运行测试", [s]);

  assert.equal(matches.length, 1);
  assert.ok(matches[0]!.relevance >= 0.3, `coverage too low: ${matches[0]!.relevance}`);
});

test("respects max matches", () => {
  const skills = [
    skill("a", "运行并修复后端测试"),
    skill("b", "运行后端测试并检查覆盖率"),
    skill("c", "运行测试并修复失败用例"),
    skill("d", "运行测试套件并输出报告"),
  ];
  const matcher = new LexicalSkillMatcher({ maxMatches: 3 });

  const matches = matcher.match("运行测试", skills);

  // Query bigrams are 运行/行测/测试. "c" and "d" both contain all three
  // (relevance 1.0), "a"/"b" only 运行+测试 (2/3) — the cap keeps the top-3:
  // relevance descending, ties broken by name Ordinal (c < d, then a).
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map((m) => m.skill.name), ["c", "d", "a"]);
});

test("orders by relevance descending", () => {
  const relevant = skill("backend-tests", "运行并修复后端测试");
  const unrelated = skill("deploy", "部署到生产环境并执行迁移");
  const matcher = new LexicalSkillMatcher();

  const matches = matcher.match("运行测试", [unrelated, relevant]);

  assert.equal(matches[0]!.skill.name, "backend-tests");
});

test("equal scores are sorted by name ordinal, not locale", () => {
  // Both skills tokenize identically (their lowercased names add no overlap), so
  // relevance is identical; Ordinal (UTF-16 code-unit) ordering puts uppercase
  // 'B' (0x42) before lowercase 'a' (0x61) — a case-sensitive code-unit order, NOT
  // locale-insensitive ordering.
  const upper = skill("Beta", "运行并修复后端测试");
  const lower = skill("alpha", "运行并修复后端测试");
  const matcher = new LexicalSkillMatcher();

  const matches = matcher.match("运行测试", [lower, upper]);

  assert.deepEqual(matches.map((m) => m.skill.name), ["Beta", "alpha"]);
});

test("empty or null input returns empty", () => {
  const s = skill("backend-tests", "运行并修复后端测试");
  const matcher = new LexicalSkillMatcher();

  assert.deepEqual(matcher.match("", [s]), []);
  assert.deepEqual(matcher.match("   ", [s]), []);
  assert.deepEqual(matcher.match(null as unknown as string, [s]), []);
  assert.deepEqual(matcher.match("运行测试", []), []);
  assert.deepEqual(matcher.match("运行测试", null as unknown as readonly Skill[]), []);
});

test("english stop words do not distort scoring", () => {
  // "the / to / with" 等停用词不计入，避免无意义的重叠拉高相关度。
  const s = skill("deploy", "Deploy the app to production with migrations");
  const matcher = new LexicalSkillMatcher();

  const matches = matcher.match("what is the weather", [s]);

  assert.deepEqual(matches, []);
});
