import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  ancestorAgentsSkillDirectories,
  loadSkills,
  loadSkillsFromUserAndProject,
  userAgentsSkillsDirectory,
} from "@di/coding-agent";

/**
 *
 * flat-style `<root>/<name>.md`; within a single source a same-name directory×
 * flat conflict warns and the later-loaded flat form wins; cross-source overrides
 * (later source wins) are designed priority and never warn; bad files are skipped
 * with a warning; enumeration is deterministic.
 */

function writeSkill(root: string, name: string, description: string, frontmatterName?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${frontmatterName ?? name}\ndescription: ${description}\n---\nbody of ${name}`);
  return file;
}

function writeFlatSkill(root: string, name: string, description: string, frontmatterName?: string): string {
  mkdirSync(root, { recursive: true });
  const file = join(root, `${name}.md`);
  writeFileSync(file, `---\nname: ${frontmatterName ?? name}\ndescription: ${description}\n---\nbody of ${name}`);
  return file;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "di-skills-repo-"));
}

test("load returns user skills sorted by name", () => {
  const root = tempRoot();
  try {
    const user = join(root, "user");
    const proj = join(root, "proj");
    writeSkill(user, "zebra", "Z 技能");
    writeSkill(user, "alpha", "A 技能");
    const skills = loadSkillsFromUserAndProject(user, proj);
    assert.deepEqual(skills.map((s) => s.name), ["alpha", "zebra"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project overrides same-name user skill", () => {
  const root = tempRoot();
  try {
    const user = join(root, "user");
    const proj = join(root, "proj");
    writeSkill(user, "deploy", "用户版本");
    writeSkill(proj, "deploy", "项目版本");
    const skills = loadSkillsFromUserAndProject(user, proj);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.description, "项目版本");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("merges user and project skills", () => {
  const root = tempRoot();
  try {
    const user = join(root, "user");
    const proj = join(root, "proj");
    writeSkill(user, "user-only", "U");
    writeSkill(proj, "proj-only", "P");
    const skills = loadSkillsFromUserAndProject(user, proj);
    assert.deepEqual(skills.map((s) => s.name), ["proj-only", "user-only"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing directories return empty", () => {
  const root = tempRoot();
  try {
    const skills = loadSkillsFromUserAndProject(join(root, "no-user"), join(root, "no-proj"));
    assert.equal(skills.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directories without SKILL.md are skipped", () => {
  const root = tempRoot();
  try {
    const user = join(root, "user");
    mkdirSync(join(user, "readme-only"), { recursive: true });
    const skills = loadSkillsFromUserAndProject(user, join(root, "proj"));
    assert.equal(skills.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid skill is skipped and warned", () => {
  const root = tempRoot();
  try {
    const user = join(root, "user");
    writeSkill(user, "good", "ok");
    const badDir = join(user, "bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "SKILL.md"), "不是合法 skill");
    const warnings: string[] = [];
    const skills = loadSkillsFromUserAndProject(user, join(root, "proj"), (m) => warnings.push(m));
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "good");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /bad/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill whose name mismatches directory is skipped and warned", () => {
  const root = tempRoot();
  try {
    const user = join(root, "user");
    const dir = join(user, "foo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: bar\ndescription: y\n---\nbody");
    const warnings: string[] = [];
    const skills = loadSkillsFromUserAndProject(user, join(root, "proj"), (m) => warnings.push(m));
    assert.equal(skills.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /foo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flat markdown files are loaded as skills", () => {
  const root = tempRoot();
  try {
    const user = join(root, "user");
    writeFlatSkill(user, "release", "发布检查清单");
    const skills = loadSkillsFromUserAndProject(user, join(root, "proj"));
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "release");
    assert.equal(skills[0]!.description, "发布检查清单");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flat file name mismatch is skipped and warned", () => {
  const root = tempRoot();
  try {
    const user = join(root, "user");
    mkdirSync(user, { recursive: true });
    writeFileSync(join(user, "foo.md"), "---\nname: bar\ndescription: y\n---\nbody");
    const warnings: string[] = [];
    const skills = loadSkillsFromUserAndProject(user, join(root, "proj"), (m) => warnings.push(m));
    assert.equal(skills.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /foo\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project flat overrides user flat", () => {
  const root = tempRoot();
  try {
    const user = join(root, "user");
    const proj = join(root, "proj");
    writeFlatSkill(user, "release", "用户版本");
    writeFlatSkill(proj, "release", "项目版本");
    const skills = loadSkillsFromUserAndProject(user, proj);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.description, "项目版本");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-source flat and directory same name: flat wins and warns", () => {
  // When flat and directory sources share a name, the directory loads first,
  // flat loads later within the same source, so the later flat form overrides
  // with a same-source conflict warning.
  const root = tempRoot();
  try {
    const user = join(root, "user");
    writeSkill(user, "deploy", "目录版本");
    writeFlatSkill(user, "deploy", "扁平版本");
    const warnings: string[] = [];
    const skills = loadSkillsFromUserAndProject(user, join(root, "proj"), (m) => warnings.push(m));
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.description, "扁平版本");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /名称冲突/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-source same-name override does not warn (priority is designed)", () => {
  const root = tempRoot();
  try {
    const user = join(root, "user");
    const proj = join(root, "proj");
    writeSkill(user, "deploy", "用户版本");
    writeSkill(proj, "deploy", "项目版本");
    const warnings: string[] = [];
    const skills = loadSkills([user, proj], (m) => warnings.push(m));
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.description, "项目版本");
    assert.equal(warnings.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("four-source standard ordering: later source wins, project .di highest", () => {
  const root = tempRoot();
  try {
    const home = join(root, "home");
    const workspace = join(root, "ws");
    const projDir = join(workspace, "proj");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    mkdirSync(projDir, { recursive: true });
    // Standard 4-source assembly per CliHost: [user .agents, user .di, ancestor
    // .agents far→near, project .di].
    const sources = [
      userAgentsSkillsDirectory(home), // home/.agents/skills (lowest)
      join(home, ".di", "skills"), // user .di skills
      ...ancestorAgentsSkillDirectories(projDir), // ws/.agents (far) then ws/proj/.agents (near)
      join(projDir, ".di", "skills"), // project .di skills (highest)
    ];
    writeSkill(sources[0]!, "shared", "user-agents");
    writeSkill(sources[1]!, "shared", "user-di");
    writeSkill(sources[2]!, "shared", "proj-agents-far");
    writeSkill(sources[3]!, "shared", "proj-agents-near");
    writeSkill(sources[4]!, "shared", "proj-di");
    const skills = loadSkills(sources);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.description, "proj-di");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("traversal order is deterministic across repeat loads", () => {
  const root = tempRoot();
  try {
    const user = join(root, "user");
    writeSkill(user, "b", "B");
    writeSkill(user, "a", "A");
    writeFlatSkill(user, "c", "C");
    const warnings1: string[] = [];
    const warnings2: string[] = [];
    const s1 = loadSkills([user], (m) => warnings1.push(m));
    const s2 = loadSkills([user], (m) => warnings2.push(m));
    assert.deepEqual(s1.map((s) => s.name), s2.map((s) => s.name));
    assert.deepEqual(warnings1, warnings2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
