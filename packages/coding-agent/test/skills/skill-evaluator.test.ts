import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateSkillTokens,
  evaluateSkillSet,
  LexicalSkillMatcher,
  type Skill,
  type SkillTestCase,
} from "@di/coding-agent";

/**
 * P6.3b card — skill evaluator metrics (port of C# `Di.Tests/Skills/SkillEvaluatorTests.cs`
 * at baseline 09f4e08): precision / recall / no-match rate / average context
 * tokens over a labeled case set (trigger tests + exclusion tests).
 */

function skill(name: string, description: string): Skill {
  return {
    name,
    description,
    instructions: "指令正文",
    metadata: {},
    allowedTools: [],
    disableModelInvocation: false,
    directory: "",
  };
}

const TWO_SKILLS: readonly Skill[] = [skill("backend-tests", "运行并修复后端测试"), skill("deploy", "部署到生产环境")];

test("Evaluate_PerfectMatcher_PrecisionAndRecallAreOne", () => {
  const cases: readonly SkillTestCase[] = [
    { message: "运行测试", expectedSkills: ["backend-tests"] },
    { message: "部署到生产", expectedSkills: ["deploy"] },
    { message: "今天天气如何", expectedSkills: [] }, // exclusion: must not hit any skill
  ];

  const metrics = evaluateSkillSet(new LexicalSkillMatcher(), TWO_SKILLS, cases);

  assert.equal(metrics.precision, 1.0);
  assert.equal(metrics.recall, 1.0);
  assert.ok(Math.abs(metrics.noMatchRate - 1 / 3) < 1e-9);
  assert.ok(metrics.averageContextTokens > 0, "每回合应有非零的 skill 上下文成本");
});

test("Evaluate_OverActivation_LowersPrecision", () => {
  const skills: readonly Skill[] = [skill("a", "运行并修复后端测试"), skill("b", "运行测试并检查覆盖率")];
  const cases: readonly SkillTestCase[] = [{ message: "运行测试", expectedSkills: ["a"] }]; // expects only a, both a+b hit

  const metrics = evaluateSkillSet(new LexicalSkillMatcher(), skills, cases);

  assert.equal(metrics.precision, 0.5); // 2 activated, 1 correct
  assert.equal(metrics.recall, 1.0);
});

test("Evaluate_AllUnrelated_NoMatchRateIsOne", () => {
  const cases: readonly SkillTestCase[] = [
    { message: "今天天气不错", expectedSkills: [] },
    { message: "随便聊聊", expectedSkills: [] },
  ];

  const metrics = evaluateSkillSet(new LexicalSkillMatcher(), TWO_SKILLS, cases);

  assert.equal(metrics.noMatchRate, 1.0);
  assert.equal(metrics.precision, 0.0);
  assert.equal(metrics.recall, 0.0);
});

test("EstimateTokens_GrowsWhenSkillsAreActive", () => {
  // Activated = the advertisement line is replaced by the full instructions; when the
  // instructions are longer than the ad line the cost rises (the ad block skips active skills).
  const skills: readonly Skill[] = [
    { ...skill("backend-tests", "运行并修复后端测试"), instructions: "x".repeat(200) },
    skill("deploy", "部署到生产环境"),
  ];
  const idle = estimateSkillTokens(skills, []);
  const active = estimateSkillTokens(skills, ["backend-tests"]);

  assert.ok(idle > 0);
  assert.ok(active > idle, "激活长正文 skill 应比纯广告块更耗上下文");
});
