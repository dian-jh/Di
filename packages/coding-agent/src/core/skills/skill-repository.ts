import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseSkillMarkdown } from "./skill-markdown.ts";
import { SkillFormatError, type Skill } from "./skill.ts";

/*
 * Skill 仓库：发现 + 合并。来源按优先级有序：后面的源覆盖前面同名的
 * （具体环境优先，与配置分层同一心智）。单源内同名冲突（目录式 × 扁平式）告警，
 * 不静默覆盖。无效 skill（解析失败 / 读盘失败）跳过并回调告警，绝不让启动失败。
 *
 * 镜像 （）。发现规则：
 * <root>/<name>/SKILL.md（MS 规范目录式）或 <root>/<name>.md（扁平式，
 * 对齐 Pi 的.pi/skills/*.md 惯例）。frontmatter 的 name 必须与父目录名 / 文件
 * 基名一致，否则该 skill 跳过并告警。目录式先加载、扁平式后加载：同源同名时扁平
 * 覆盖目录式（顺序确定性）；跨源覆盖是设计好的优先级，不告警。
 */

/** 两参数便利形式：用户级 + 项目级（后面的项目覆盖同名的用户）。 */
export function loadSkillsFromUserAndProject(
  userDirectory: string,
  projectDirectory: string,
  warn?: (message: string) => void,
): Skill[] {
  return loadSkills([userDirectory, projectDirectory], warn);
}

/** 从有序源目录列表加载全部 skill，按名称排序返回。 */
export function loadSkills(sources: readonly string[], warn?: (message: string) => void): Skill[] {
  const merged = new Map<string, Skill>();
  for (const dir of sources) {
    const source = new Map<string, Skill>();
    loadInto(dir, source, warn);
    for (const [name, skill] of source) {
      merged.set(name, skill);
    }
  }
  return [...merged.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function loadInto(skillsRoot: string, into: Map<string, Skill>, warn?: (message: string) => void): void {
  if (!isDirectory(skillsRoot)) return;

  const entries = readdirSync(skillsRoot, { withFileTypes: true });

  // 目录式 <name>/SKILL.md（MS 规范）：先加载。
  const dirNames = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const dirName of dirNames) {
    const dir = join(skillsRoot, dirName);
    const markdown = join(dir, "SKILL.md");
    if (!existsSync(markdown)) continue; // 目录下没有 SKILL.md 就不是 skill
    try {
      const skill = parseSkillMarkdown(readFileSync(markdown, "utf8"), basename(dir));
      addSkill(into, { ...skill, directory: dir }, warn, `目录 ${markdown}`);
    } catch (err) {
      if (isSkippableError(err)) {
        warn?.(`跳过无效 skill ${markdown}: ${errorMessage(err)}`);
      } else {
        throw err;
      }
    }
  }

  // 扁平 <name>.md（对齐 Pi 的 .pi/skills/*.md 惯例）：单文件 skill 无需建目录。
  const fileNames = entries
    .filter((e) => e.isFile() && isMarkdownFile(e.name))
    .map((e) => e.name)
    .sort();
  for (const fileName of fileNames) {
    const file = join(skillsRoot, fileName);
    try {
      const skill = parseSkillMarkdown(readFileSync(file, "utf8"), basename(file, ".md"));
      addSkill(into, { ...skill, directory: dirname(file) }, warn, `文件 ${file}`);
    } catch (err) {
      if (isSkippableError(err)) {
        warn?.(`跳过无效 skill ${file}: ${errorMessage(err)}`);
      } else {
        throw err;
      }
    }
  }
}

function addSkill(
  into: Map<string, Skill>,
  skill: Skill,
  warn: ((message: string) => void) | undefined,
  sourceDesc: string,
): void {
  if (into.has(skill.name)) {
    warn?.(`skill 名称冲突：'${skill.name}' 已存在，${sourceDesc} 覆盖。`);
  }
  into.set(skill.name, skill);
}

/** 枚举顺序确定：目录式与扁平式分组内按名称排序（同名结果不受影响，仅稳定告警顺序）。 */

/** <dir> 存在且是目录（镜像 Directory.Exists 对文件路径返回 false）。 */
function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Windows 上.md 后缀大小写不敏感（镜像 EnumerateFiles("*.md") 的行为）。 */
function isMarkdownFile(name: string): boolean {
  return process.platform === "win32" ? /\.md$/i.test(name) : name.endsWith(".md");
}

/** 跳过范围对齐 ：SkillFormatError + 文件系统错误（IOException/UnauthorizedAccess）。 */
function isSkippableError(err: unknown): boolean {
  if (err instanceof SkillFormatError) return true;
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === "string"
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
