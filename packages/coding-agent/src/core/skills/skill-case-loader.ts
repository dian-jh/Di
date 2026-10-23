import { readFileSync } from "node:fs";

/*
 * Labeled skill-matcher case loader: a JSON array of
 * `{"message": "...", "expected_skills": [...]}`
 * items (snake_case, matching the wire format) for the skill evaluator
 * (trigger / exclusion tests). `message` is required and non-blank;
 * `expected_skills` is optional (absent = an exclusion case expected to match
 * nothing). Tolerant like the skill repository: file-level errors (missing /
 * invalid JSON / root not an array) throw; entry-level errors warn (via the
 * `warn` callback) and skip.
 */

export interface SkillTestCase {
  readonly message: string;
  readonly expectedSkills: readonly string[];
}

/*
 * Load the labeled cases from `path`. Throws on file-level errors (mirroring the
 * file read and JSON parse errors); entry-level
 * problems are reported through `warn` and skipped.
 */
export function loadSkillCases(path: string, warn?: (message: string) => void): readonly SkillTestCase[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`无法读取用例文件: ${path}`, { cause });
  }

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (cause) {
    throw new Error(`用例文件不是合法 JSON: ${path}`, { cause });
  }
  if (!Array.isArray(root)) {
    throw new Error(`用例文件必须是 JSON 数组（${path}）`);
  }

  const cases: SkillTestCase[] = [];
  let index = 0;
  for (const item of root) {
    index += 1;
    if (!isPlainObject(item)) {
      warn?.(`第 ${index} 项不是对象，跳过`);
      continue;
    }
    const obj = item as Record<string, unknown>;
    const message = obj["message"];
    if (typeof message !== "string" || message.trim().length === 0) {
      warn?.(`第 ${index} 项缺少非空 message，跳过`);
      continue;
    }

    const expected: string[] = [];
    if (obj["expected_skills"] !== undefined) {
      const expectedSkills = obj["expected_skills"];
      if (!Array.isArray(expectedSkills)) {
        warn?.(`第 ${index} 项 expected_skills 不是数组，跳过`);
        continue;
      }
      let valid = true;
      for (const name of expectedSkills) {
        if (typeof name !== "string") {
          valid = false;
          break;
        }
      }
      if (!valid) {
        warn?.(`第 ${index} 项 expected_skills 含非字符串项，跳过`);
        continue;
      }
      for (const name of expectedSkills) expected.push(name as string);
    }

    cases.push({ message, expectedSkills: expected });
  }
  return cases;
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
