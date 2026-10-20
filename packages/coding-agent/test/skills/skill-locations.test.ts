import test from "node:test";
import assert from "node:assert/strict";
import { join, parse } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  ancestorAgentsSkillDirectories,
  projectAgentsSkillsDirectory,
  userAgentsSkillsDirectory,
} from "@di/coding-agent";

/**
 * P6.2a unit 2 — source ordering. Mirrors `Core/Skills/SkillLocations.cs` at
 * baseline 09f4e08: user `.agents/skills` → user `.di/skills` → project ancestor
 * `.agents/skills` far-to-near → current project `.di/skills`; a `.git` file OR
 * directory is a root marker.
 */

test("user agents skills dir lives under the OS home directory", () => {
  assert.equal(userAgentsSkillsDirectory(join("C:", "home")), join("C:", "home", ".agents", "skills"));
});

test("project agents skills dir lives under any directory", () => {
  assert.equal(projectAgentsSkillsDirectory(join("C:", "ws")), join("C:", "ws", ".agents", "skills"));
});

test("ancestor discovery stops at a .git DIRECTORY and orders far-to-near", () => {
  const root = mkdtempSync(join(tmpdir(), "di-skills-loc-"));
  try {
    const repo = join(root, "repo");
    const start = join(repo, "a", "b", "c");
    mkdirSync(start, { recursive: true });
    mkdirSync(join(repo, ".git"));
    const dirs = ancestorAgentsSkillDirectories(start);
    assert.deepEqual(dirs, [
      join(repo, ".agents", "skills"),
      join(repo, "a", ".agents", "skills"),
      join(repo, "a", "b", ".agents", "skills"),
      join(repo, "a", "b", "c", ".agents", "skills"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a .git FILE is also a root marker (worktree/submodule)", () => {
  const root = mkdtempSync(join(tmpdir(), "di-skills-loc-"));
  try {
    const repo = join(root, "repo");
    const start = join(repo, "src");
    mkdirSync(start, { recursive: true });
    writeFileSync(join(repo, ".git"), "gitdir: ../real-git");
    const dirs = ancestorAgentsSkillDirectories(start);
    assert.deepEqual(dirs, [
      join(repo, ".agents", "skills"),
      join(repo, "src", ".agents", "skills"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the start directory itself can be the git root", () => {
  const root = mkdtempSync(join(tmpdir(), "di-skills-loc-"));
  try {
    mkdirSync(join(root, ".git"));
    const dirs = ancestorAgentsSkillDirectories(root);
    assert.deepEqual(dirs, [join(root, ".agents", "skills")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without a root marker, ancestors walk to the filesystem root", () => {
  // Injected isRoot that never fires keeps the walk pure (no fs reads): the
  // candidate list must reach the filesystem root (far) and end at the start
  // directory (near).
  const startDir = join(tmpdir(), "di-loc", "ws", "proj", "src");
  const dirs = ancestorAgentsSkillDirectories(startDir, { isRoot: () => false });
  const root = parse(startDir).root;
  assert.equal(dirs[0], join(root, ".agents", "skills"));
  assert.equal(dirs[dirs.length - 1], join(startDir, ".agents", "skills"));
  assert.ok(dirs.length >= 3);
});
