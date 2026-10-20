/**
 * Skill model and SKILL.md format error.
 *
 * Mirrors `Core/Skills/Skill.cs` and the format errors of
 * `Core/Skills/SkillMarkdown.cs` at baseline 09f4e08. Fields align with the
 * Microsoft Agent Framework SKILL.md spec (learn.microsoft.com/agent-framework/
 * agents/skills).
 */

/** 激活用名称上限（MS 规范：≤64 字符，仅小写字母/数字/连字符）。 */
export const MAX_SKILL_NAME_LENGTH = 64;

/** description 上限（≤1024 字符）。 */
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

/** SKILL.md 格式错误（frontmatter 缺失 / 必需字段缺失或非法 / 正文为空）。 */
export class SkillFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillFormatError";
  }
}

/** 一个 Skill：SKILL.md 的 frontmatter 元数据 + 指令正文。 */
export interface Skill {
  /** 激活用名称；必须匹配父目录名 / 文件基名。 */
  readonly name: string;
  /** 一句话用途（≤1024 字符），自动匹配与 load_skill 的决策都靠它。 */
  readonly description: string;
  /** 注入给模型的指令正文（frontmatter 之后的正文）。 */
  readonly instructions: string;
  /** frontmatter metadata 段的任意键值元数据（author/version 等）。 */
  readonly metadata: Readonly<Record<string, string>>;
  /** allowed-tools：该 skill 预批准的工具白名单（仅解析存储，非权限约束）。 */
  readonly allowedTools: readonly string[];
  /** disable-model-invocation：true 时该 skill 不进广告/自动匹配，只接受显式调用。 */
  readonly disableModelInvocation: boolean;
  /** skill 所在目录（SKILL.md 父目录 / 扁平 .md 文件所在目录）。由仓库加载填充。 */
  readonly directory: string;
}
