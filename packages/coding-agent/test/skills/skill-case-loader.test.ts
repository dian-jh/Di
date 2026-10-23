import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillCases } from "@di/coding-agent";

/**
 *
 * File-level errors throw; entry-level errors warn and skip (the same tolerant
 * philosophy as the skill repository).
 */

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function writeCases(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "di-cases-"));
  roots.push(root);
  const path = join(root, "cases.json");
  writeFileSync(path, content);
  return path;
}

test("Load_ValidFile_ParsesCases", () => {
  const path = writeCases(`[
      { "message": "跑一下后端测试", "expected_skills": ["backend-tests"] },
      { "message": "随便聊聊", "expected_skills": [] }
    ]`);

  const cases = loadSkillCases(path);

  assert.equal(cases.length, 2);
  assert.equal(cases[0]!.message, "跑一下后端测试");
  assert.deepEqual(cases[0]!.expectedSkills, ["backend-tests"]);
  assert.equal(cases[1]!.message, "随便聊聊");
  assert.deepEqual(cases[1]!.expectedSkills, []);
});

test("Load_MissingExpectedSkills_DefaultsToExclusionCase", () => {
  const path = writeCases(`[ { "message": "帮我部署上线" } ]`);

  const cases = loadSkillCases(path);

  assert.equal(cases.length, 1);
  assert.deepEqual(cases[0]!.expectedSkills, []);
});

test("Load_FileNotFound_Throws", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "di-no-cases-")), "no-such-cases.json");
  roots.push(missing);

  assert.throws(() => loadSkillCases(missing));
});

test("Load_InvalidJson_Throws", () => {
  const path = writeCases("这不是 JSON");

  assert.throws(() => loadSkillCases(path));
});

test("Load_RootNotArray_Throws", () => {
  const path = writeCases(`{ "message": "hi" }`);

  assert.throws(() => loadSkillCases(path), /JSON 数组/);
});

test("Load_MalformedEntry_WarnsAndSkips", () => {
  const path = writeCases(`[
      { "message": "" },
      { "message": "跑一下后端测试", "expected_skills": ["backend-tests"] },
      { "expected_skills": ["x"] }
    ]`);
  const warnings: string[] = [];

  const cases = loadSkillCases(path, (msg) => warnings.push(msg));

  assert.equal(cases.length, 1);
  assert.deepEqual(cases[0]!.expectedSkills, ["backend-tests"]);
  assert.equal(warnings.length, 2);
});

test("Load_ExpectedSkillsNotArray_WarnsAndSkips", () => {
  const path = writeCases(`[ { "message": "hi", "expected_skills": "backend-tests" } ]`);
  const warnings: string[] = [];

  const cases = loadSkillCases(path, (msg) => warnings.push(msg));

  assert.equal(cases.length, 0);
  assert.equal(warnings.length, 1);
});

test("Load_ExpectedSkillsContainsNonString_WarnsAndSkips", () => {
  const path = writeCases(`[ { "message": "hi", "expected_skills": ["ok", 42] } ]`);
  const warnings: string[] = [];

  const cases = loadSkillCases(path, (msg) => warnings.push(msg));

  assert.equal(cases.length, 0);
  assert.equal(warnings.length, 1);
});
