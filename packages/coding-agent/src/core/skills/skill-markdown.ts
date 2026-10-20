import {
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  SkillFormatError,
  type Skill,
} from "./skill.ts";

/**
 * 解析 SKILL.md：以 `---` 包裹的 YAML frontmatter + 正文指令。
 *
 * 逐行复刻 `Core/Skills/SkillMarkdown.cs`（baseline 09f4e08）的手写单行 / 单层缩进
 * 解析器——C# 基线并未使用 YAML 库（YamlDotNet 仅见于旧注释），因此支持格式必须与
 * 之逐字一致，不因“换了 YAML 库”而无意变化。严格性（对齐 MS）：受识别字段必须小写且
 * 只能出现一次（重复 → 拒绝）；未知顶层字段忽略（向前兼容）。
 */

/** 受识别字段集合：重复出现即拒绝加载。 */
const recognizedKeys = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  "disable-model-invocation",
]);

const validNamePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 剥掉值两侧的引号（镜像 C# `.Trim('"', '\'')`）。 */
function stripQuotes(value: string): string {
  return value.replace(/^["']+|["']+$/g, "");
}

/**
 * 解析一份 SKILL.md 内容。若提供 expectedName（父目录名 / 文件基名），会校验
 * frontmatter 的 name 与之一致（MS 规范要求）。
 */
export function parseSkillMarkdown(content: string, expectedName?: string): Skill {
  // 容忍 BOM 与前导空行（镜像 C# TrimStart((char)0xFEFF, '\r', '\n')）。
  let text = content.replace(/^[\uFEFF\r\n]+/, "");

  const firstLineEnd = text.indexOf("\n");
  const firstLine = firstLineEnd < 0 ? text : text.slice(0, firstLineEnd);
  if (firstLine.replace(/\r+$/, "") !== "---") {
    throw new SkillFormatError("SKILL.md 必须以 '---' 开头（YAML frontmatter）。");
  }

  const end = findFrontmatterEnd(text, firstLineEnd + 1);
  if (end < 0) {
    throw new SkillFormatError("未找到 frontmatter 的结束行 '---'。");
  }

  const frontmatter = text.slice(firstLineEnd + 1, end);

  let name: string | undefined;
  let description: string | undefined;
  const metadata: Record<string, string> = {};
  let allowedTools: string[] = [];
  let disableModelInvocation = false;
  const seen = new Set<string>(); // 受识别字段出现集合 → 重复即拒绝
  let inMetadata = false;

  for (const rawLine of frontmatter.split("\n")) {
    const line = rawLine.replace(/\r+$/, "");
    if (line.trim() === "") continue;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) continue; // YAML 注释
    const indent = line.length - trimmed.length;

    if (inMetadata) {
      if (indent > 0) {
        const mColon = trimmed.indexOf(":");
        if (mColon > 0) {
          const mKey = trimmed.slice(0, mColon).trim();
          const mValue = stripQuotes(trimmed.slice(mColon + 1).trim());
          if (!Object.hasOwn(metadata, mKey)) {
            metadata[mKey] = mValue; // MS：重复键保留首个
          }
        }
        continue;
      }
      inMetadata = false;
    }

    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue; // 忽略无法解析的行
    const key = trimmed.slice(0, colon).trim();
    const value = stripQuotes(trimmed.slice(colon + 1).trim());

    if (recognizedKeys.has(key)) {
      if (seen.has(key)) {
        throw new SkillFormatError(`frontmatter 字段 '${key}' 重复出现。`);
      }
      seen.add(key);
    }

    switch (key) {
      case "name":
        name = value;
        break;
      case "description":
        description = value;
        break;
      case "metadata":
        if (value.length === 0) inMetadata = true;
        break;
      case "allowed-tools":
        allowedTools = value.split(" ").filter((s) => s.length > 0);
        break;
      case "disable-model-invocation":
        disableModelInvocation = value.toLowerCase() === "true";
        break;
      // license / compatibility / 未知字段：忽略（向前兼容）
    }
  }

  if (name === undefined || name.trim() === "") {
    throw new SkillFormatError("frontmatter 缺少 name。");
  }
  if (!isValidName(name)) {
    throw new SkillFormatError(
      `name '${name}' 非法：仅限小写字母/数字/连字符，≤${MAX_SKILL_NAME_LENGTH} 字符，不得以连字符开头/结尾或含连续连字符。`,
    );
  }
  if (expectedName !== undefined && name !== expectedName) {
    throw new SkillFormatError(`name '${name}' 与父目录名 '${expectedName}' 不一致（必须匹配）。`);
  }
  if (description === undefined || description.trim() === "") {
    throw new SkillFormatError("frontmatter 缺少 description。");
  }
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    throw new SkillFormatError(
      `description 超过 ${MAX_SKILL_DESCRIPTION_LENGTH} 字符（当前 ${description.length}）。`,
    );
  }

  const instructions = text.slice(end).replace(/^[\r\n]+/, "").trim();
  if (instructions.length === 0) {
    throw new SkillFormatError("SKILL.md 正文为空。");
  }

  return {
    name,
    description,
    instructions,
    metadata,
    allowedTools,
    disableModelInvocation,
    directory: "",
  };
}

function isValidName(name: string): boolean {
  return name.length <= MAX_SKILL_NAME_LENGTH && validNamePattern.test(name);
}

/** 从 start 起找独立成行的 "---"，返回该行末尾索引（不含换行）；找不到返回 -1。 */
function findFrontmatterEnd(content: string, start: number): number {
  let pos = start;
  while (pos <= content.length) {
    const nl = content.indexOf("\n", pos);
    const lineEnd = nl < 0 ? content.length : nl;
    const line = content.slice(pos, lineEnd).replace(/\r+$/, "");
    if (line === "---") return lineEnd;
    if (nl < 0) return -1;
    pos = nl + 1;
  }
  return -1;
}
