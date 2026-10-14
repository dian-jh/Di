/**
 * 斜杠命令文本解析 + 归一化（纯函数，可单测）。
 *
 * 命令补全（Editor 的 CombinedAutocompleteProvider）对 skill 条目以 `skill:<名>` 形态补全
 * （如 `/skill:code-review `），后端注册表只认 `/skill <名>`。提交前把该形态归一为后端
 * `/skill <名称> [参数]`，其余命令原样拆分。
 */

export interface ParsedCommand {
  name: string;
  args: string;
}

/** 解析一条斜杠命令文本：拆命令名与参数；把 `skill:<名>` 补全形态归一为后端 `/skill <名> [参数]`。 */
export function normalizeSlash(text: string): ParsedCommand {
  const space = text.indexOf(" ");
  const rawName = space < 0 ? text.slice(1) : text.slice(1, space);
  const args = space < 0 ? "" : text.slice(space + 1).trim();
  if (rawName.startsWith("skill:") && rawName.length > "skill:".length) {
    const skillName = rawName.slice("skill:".length);
    return { name: "skill", args: `${skillName}${args ? ` ${args}` : ""}` };
  }
  return { name: rawName, args };
}