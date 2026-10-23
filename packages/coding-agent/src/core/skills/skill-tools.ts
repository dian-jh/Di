import type { ToolCall, ToolSpec } from "@di/ai";
import type { ToolExecutor, ToolObservation } from "@di/agent";
import type { Skill } from "./skill.ts";

/*
 * Model-visible skill tools (the "Load" phase of progressive disclosure, aligned
 * with MS Agent Framework's load_skill): the model sees the skill list in the
 * advertisement block and loads a skill's FULL instructions by name on demand
 * instead of keeping every body resident. at
 *. NOTE (unit 7): `allowed-tools` is parsed metadata, NOT an
 * enforced permission constraint in this codebase — nothing here claims to
 * sandbox tool execution.
 */

/** The load_skill tool definition the model can call. */
export const LOAD_SKILL_TOOL: ToolSpec = {
  name: "load_skill",
  description:
    "按名称加载一个已列出 skill 的完整指令正文。当任务匹配某个可用 skill 时调用，不要凭空调用。",
  parameters: {
    type: "object",
    properties: {
      skill_name: { type: "string", description: "要加载的 skill 名称（来自可用 skills 列表）" },
    },
    required: ["skill_name"],
  },
};

/** Whether a tool call targets load_skill. */
export function isLoadSkillCall(call: ToolCall): boolean {
  return call.name === LOAD_SKILL_TOOL.name;
}

/*
 * Execute load_skill: return the skill's full instructions (with a directory
 * hint so bundled files resolve relative to it); unknown names / missing or
 * invalid arguments return an `error:`-prefixed string. Never throws — every
 * failure is communicated in the returned text (`ExecuteLoadSkill`,
 * which catches `JsonException` and returns an error string).
 */
export function executeLoadSkill(call: ToolCall, skills: ReadonlyMap<string, Skill>): string {
  let name: string;
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (typeof parsed !== "object" || parsed === null) return "error: 缺少参数 skill_name";
    const raw = (parsed as { skill_name?: unknown }).skill_name;
    if (typeof raw !== "string" || raw.trim().length === 0) return "error: 缺少参数 skill_name";
    name = raw;
  } catch {
    return "error: arguments 不是合法 JSON";
  }

  const skill = skills.get(name);
  return skill === undefined
    ? `error: 未找到 skill '${name}'（可用列表见系统上下文）`
    : renderLoadedSkill(skill);
}

/*
 * Render a loaded skill's full body, attaching the skill directory so the model
 * can resolve the relative paths of bundled files (scripts / references / assets).
 */
export function renderLoadedSkill(skill: Skill): string {
  return skill.directory.length === 0
    ? `【Skill：${skill.name}】${skill.description}\n\n${skill.instructions}`
    : `【Skill：${skill.name}】${skill.description}\n（skill 目录：${skill.directory}，内置文件的相对路径以此为准）\n\n${skill.instructions}`;
}

/**
 * Executor decorator: intercepts load_skill calls, delegating everything else to
 * the inner executor. Mirrors: the load_skill result is
 * a plain observation (errors are `error:`-prefixed text, never throws), so it is
 * returned with `isError: false` exactly as  marks
 * non-throwing executor results.
 */
export function createSkillAwareExecutor(
  inner: ToolExecutor,
  skills: readonly Skill[],
): ToolExecutor {
  if (inner == null) throw new TypeError("createSkillAwareExecutor: inner is required");
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    execute(call: ToolCall, signal?: AbortSignal): Promise<ToolObservation> {
      if (isLoadSkillCall(call)) {
        return Promise.resolve({ text: executeLoadSkill(call, byName), isError: false });
      }
      return inner.execute(call, signal);
    },
  };
}
