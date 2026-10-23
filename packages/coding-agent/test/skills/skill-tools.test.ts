import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import type { ToolCall, ToolSpec } from "@di/ai";
import type { ToolExecutor, ToolObservation } from "@di/agent";
import type { Skill } from "@di/coding-agent";
import {
  LOAD_SKILL_TOOL,
  createSkillAwareExecutor,
  executeLoadSkill,
  isLoadSkillCall,
  renderLoadedSkill,
} from "@di/coding-agent";

/**
 *
 * demand (never resident in the ad); unknown names / missing / invalid arguments
 * return `error:`-prefixed text; a directory hint is attached so the skill's
 * bundled files resolve relative to it. Unit 7: `allowed-tools` is parsed
 * metadata, NOT an enforced permission constraint in this codebase — nothing
 * here claims sandboxing.
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

function loadCall(argumentsJson: string): ToolCall {
  return { type: "tool-call", id: "c1", name: "load_skill", arguments: argumentsJson };
}

function toMap(skills: readonly Skill[]): ReadonlyMap<string, Skill> {
  return new Map(skills.map((s) => [s.name, s]));
}

class RecordingExecutor implements ToolExecutor {
  readonly calls: string[] = [];
  execute(call: ToolCall): Promise<ToolObservation> {
    this.calls.push(call.name);
    return Promise.resolve({ text: "ok", isError: false });
  }
}

test("load skill tool has name and schema", () => {
  const tool: ToolSpec = LOAD_SKILL_TOOL;

  assert.equal(tool.name, "load_skill");
  const properties = tool.parameters.properties as Record<string, unknown>;
  assert.ok(properties.skill_name !== undefined);
  assert.ok((tool.parameters.required as readonly string[]).includes("skill_name"));
});

test("isLoadSkillCall identifies load_skill calls only", () => {
  assert.equal(isLoadSkillCall(loadCall('{"skill_name":"a"}')), true);
  assert.equal(isLoadSkillCall({ type: "tool-call", id: "c1", name: "bash", arguments: "{}" }), false);
});

test("executeLoadSkill returns full instructions when found", () => {
  const skills = toMap([skill("backend-tests", "运行并修复后端测试", "先 build 再 test")]);

  const result = executeLoadSkill(loadCall('{"skill_name":"backend-tests"}'), skills);

  assert.ok(result.includes("先 build 再 test"));
  assert.ok(result.includes("backend-tests"));
});

test("executeLoadSkill unknown name returns error text", () => {
  const result = executeLoadSkill(loadCall('{"skill_name":"nope"}'), new Map());

  assert.ok(result.startsWith("error"));
});

test("executeLoadSkill missing or invalid argument returns error text", () => {
  const skills = new Map<string, Skill>();

  assert.ok(executeLoadSkill(loadCall("{}"), skills).startsWith("error"));
  assert.ok(executeLoadSkill(loadCall("not-json"), skills).startsWith("error"));
});

test("executeLoadSkill attaches directory hints for bundled files", () => {
  const dir = join("user", "pdf-tools");
  const skills = toMap([skill("pdf-tools", "提取 PDF", "转换前先读 references/formats.md", { directory: dir })]);

  const result = executeLoadSkill(loadCall('{"skill_name":"pdf-tools"}'), skills);

  assert.ok(result.includes(dir), "loaded body must expose the skill directory");
  assert.ok(result.includes("skill 目录"), "the directory hint must be present");
});

test("renderLoadedSkill omits directory hint when no directory is known", () => {
  const rendered = renderLoadedSkill(skill("a", "广告 A", "指令 A"));

  assert.ok(!rendered.includes("skill 目录"));
  assert.ok(rendered.includes("指令 A"));
});

test("skill aware executor intercepts load_skill without touching inner", async () => {
  const inner = new RecordingExecutor();
  const executor = createSkillAwareExecutor(inner, [skill("a", "广告 A", "指令 A 全文")]);

  const result = await executor.execute(loadCall('{"skill_name":"a"}'));

  assert.ok(result.text.includes("指令 A 全文"));
  assert.deepEqual(inner.calls, []);
});

test("skill aware executor delegates other tools to inner", async () => {
  const inner = new RecordingExecutor();
  const executor = createSkillAwareExecutor(inner, []);

  await executor.execute({ type: "tool-call", id: "c1", name: "bash", arguments: "{}" });

  assert.deepEqual(inner.calls, ["bash"]);
});

test("allowed-tools is inert metadata, never an enforced permission gate", async () => {
  // Unit 7 audit: a skill whose allowed-tools whitelist does NOT include bash
  // still has its full instructions loadable, and a bash call is still delegated
  // to the inner executor — nothing here filters by allowedTools or claims to
  // sandbox tool execution.
  const s = skill("pdf-tools", "提取 PDF", "读取 references 再输出", { allowedTools: ["read_file"] });
  const loaded = executeLoadSkill(loadCall('{"skill_name":"pdf-tools"}'), toMap([s]));
  assert.ok(loaded.includes("读取 references 再输出"));

  const inner = new RecordingExecutor();
  const executor = createSkillAwareExecutor(inner, [s]);
  await executor.execute({ type: "tool-call", id: "c1", name: "bash", arguments: "{}" });
  assert.deepEqual(inner.calls, ["bash"]);
});
