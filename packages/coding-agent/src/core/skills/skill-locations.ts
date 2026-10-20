import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * skill 标准位置（对齐 Agent Skills 规范与 Pi 的 resource-loader / package-manager）：
 * 除 Di 自家的 ~/.di/skills 与 <workspace>/.di/skills 外，还支持
 * ~/.agents/skills（用户标准）与 .agents/skills（项目标准，从工作目录沿祖先目录
 * 向上发现，直到 git 仓库根；无 git 则到文件系统根）。
 *
 * 镜像 `Core/Skills/SkillLocations.cs`（baseline 09f4e08）。调用方（宿主组合根）
 * 按优先级拼装源目录列表交给 SkillRepository。
 */

/** 用户级 .agents/skills（Agent Skills 规范位置），位于操作系统家目录下。 */
export function userAgentsSkillsDirectory(homeDirectory: string): string {
  return join(homeDirectory, ".agents", "skills");
}

/** 某目录下的项目级 .agents/skills。 */
export function projectAgentsSkillsDirectory(directory: string): string {
  return join(directory, ".agents", "skills");
}

export interface AncestorSkillDiscoveryOptions {
  /**
   * 覆盖默认根探测（测试可注入纯路径逻辑）：给定目录，是否视为 git 仓库根。
   * 默认探测 `<dir>/.git`（文件或目录均可，镜像 C# Directory.Exists || File.Exists）。
   */
  isRoot?: (directory: string) => boolean;
}

/**
 * 从 startDirectory 沿祖先目录向上收集 .agents/skills 目录，远 → 近
 * （git 根在前、startDirectory 在最后）。遇到含 .git 的目录即仓库根，收完该层停止；
 * 无 git 仓库则直到文件系统根。配合 SkillRepository 的“后面的源覆盖前面的”语义，
 * 最近（startDirectory 侧）的 .agents/skills 享有最高优先。
 */
export function ancestorAgentsSkillDirectories(
  startDirectory: string,
  options: AncestorSkillDiscoveryOptions = {},
): string[] {
  const isRoot = options.isRoot ?? defaultIsRoot;
  const current = resolve(startDirectory);

  let gitRoot: string | undefined;
  for (let probe = current; ; probe = parent(probe)) {
    if (isRoot(probe)) {
      gitRoot = probe;
      break;
    }
    if (probe === parent(probe)) break; // 文件系统根
  }

  const stack: string[] = [];
  for (let dir: string = current; ; dir = parent(dir)) {
    stack.push(dir);
    if (gitRoot !== undefined && samePath(dir, gitRoot)) break;
    if (dir === parent(dir)) break; // 文件系统根
  }

  const dirs: string[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    dirs.push(projectAgentsSkillsDirectory(stack[i]!));
  }
  return dirs;
}

/** 默认根探测：<dir>/.git 文件或目录均为根标记。 */
function defaultIsRoot(directory: string): boolean {
  return existsSync(join(directory, ".git"));
}

/** Windows 路径比较大小写不敏感（镜像 C# OrdinalIgnoreCase）。 */
function samePath(a: string, b: string): boolean {
  if (process.platform === "win32") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function parent(dir: string): string {
  const p = dirname(dir);
  return p === dir ? dir : p;
}
