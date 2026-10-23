import test from "node:test";
import assert from "node:assert/strict";

import type { Skill } from "@di/coding-agent";
import { LexicalSkillMatcher, computeSkillActivation } from "@di/coding-agent";

/**
 *
 * auto-matched skills are appended after and deduped against the pinned set,
 * the whole set is recomputed every turn (never cumulative), and
 * `disable-model-invocation` skills are not auto-matched yet still accept an
 * explicit (pinned) invocation.
 */

const backendTests: Skill = {
  name: "backend-tests",
  description: "运行并修复后端测试（TypeScript workspace）。当用户要求运行测试、分析失败或修复测试时使用。",
  instructions: "1. npm run build\n2. npm test",
  metadata: {},
  allowedTools: [],
  disableModelInvocation: false,
  directory: "",
};

const chat: Skill = {
  name: "chat",
  description: "普通闲聊与答疑。当用户只是聊天、提问常识或闲聊时使用。",
  instructions: "正常回答。",
  metadata: {},
  allowedTools: [],
  disableModelInvocation: false,
  directory: "",
};

const disabled: Skill = {
  name: "deploy",
  description: "部署发布（只接受显式 /skill 调用）。当用户要求部署、发布或上线时使用。",
  instructions: "部署流程。",
  metadata: {},
  allowedTools: [],
  disableModelInvocation: true,
  directory: "",
};

test("no skills returns empty", () => {
  const result = computeSkillActivation("跑一下后端测试", [], [], new LexicalSkillMatcher());

  assert.deepEqual(result.active, []);
  assert.deepEqual(result.autoMatched, []);
});

test("matching message auto activates a skill", () => {
  const result = computeSkillActivation("跑一下后端测试", [backendTests, chat], [], new LexicalSkillMatcher());

  assert.deepEqual(result.autoMatched.map((s) => s.name), ["backend-tests"]);
  assert.deepEqual(result.active.map((s) => s.name), ["backend-tests"]);
});

test("no match returns empty", () => {
  const result = computeSkillActivation("随便聊聊", [backendTests, chat], [], new LexicalSkillMatcher());

  assert.deepEqual(result.autoMatched, []);
  assert.deepEqual(result.active, []);
});

test("pinned skill is not duplicated in auto matched", () => {
  // 固定集（/skill 手动激活）已覆盖同一 skill：自动匹配要排除它，避免重复。
  const result = computeSkillActivation("跑一下后端测试", [backendTests, chat], [backendTests], new LexicalSkillMatcher());

  assert.deepEqual(result.active.map((s) => s.name), ["backend-tests"]);
  assert.deepEqual(result.autoMatched, []);
});

test("pinned plus auto matched are combined with pinned first", () => {
  // 固定集与自动匹配叠加：固定在前，自动匹配的附加在后。
  const result = computeSkillActivation("跑一下后端测试", [backendTests, chat], [chat], new LexicalSkillMatcher());

  assert.deepEqual(result.active.map((s) => s.name), ["chat", "backend-tests"]);
  assert.deepEqual(result.autoMatched.map((s) => s.name), ["backend-tests"]);
});

test("disabled model invocation skill is not auto matched", () => {
  const result = computeSkillActivation("帮我部署上线", [disabled, chat], [], new LexicalSkillMatcher());

  assert.deepEqual(result.autoMatched, []);
  assert.deepEqual(result.active, []);
});

test("disabled skill still accepts explicit pinned invocation", () => {
  // Unit 5: disable-model-invocation means "not advertised / not auto-matched",
  // never "unusable" — an explicit /skill-style pin still activates it.
  const result = computeSkillActivation("帮我部署上线", [disabled, chat], [disabled], new LexicalSkillMatcher());

  assert.deepEqual(result.active.map((s) => s.name), ["deploy"]);
  assert.deepEqual(result.autoMatched, []);
});

test("activation computation is a pure function of message and available skills", () => {
  // Gate: REPL / print / JSON / RPC must all yield the SAME activation set for the
  // same message. computeSkillActivation is that single shared pure computation:
  // repeated calls with identical inputs produce identical results and nothing
  // accumulates across calls, so every mode that feeds the same message through
  // it observes the same activation set.
  const matcher = new LexicalSkillMatcher();
  const first = computeSkillActivation("跑一下后端测试", [backendTests, chat], [], matcher);
  const second = computeSkillActivation("跑一下后端测试", [backendTests, chat], [], matcher);

  assert.deepEqual(second.active.map((s) => s.name), first.active.map((s) => s.name));
  assert.deepEqual(second.autoMatched.map((s) => s.name), first.autoMatched.map((s) => s.name));

  // An unrelated message in between must not change the result for the original
  // message — the computation holds no shared mutable state.
  const unrelated = computeSkillActivation("随便聊聊", [backendTests, chat], [], matcher);
  assert.deepEqual(unrelated.active, []);
  const third = computeSkillActivation("跑一下后端测试", [backendTests, chat], [], matcher);
  assert.deepEqual(third.active.map((s) => s.name), ["backend-tests"]);
});

test("auto matched skills are recomputed every turn, never cumulative", () => {
  // A matching turn activates backend-tests; the next unrelated turn carries NO
  // residue — the matcher result is fresh per call (recomputed every turn).
  const matcher = new LexicalSkillMatcher();
  const matching = computeSkillActivation("跑一下后端测试", [backendTests, chat], [], matcher);
  assert.deepEqual(matching.active.map((s) => s.name), ["backend-tests"]);

  const unrelated = computeSkillActivation("随便聊聊", [backendTests, chat], [], matcher);
  assert.deepEqual(unrelated.active, []);
});
