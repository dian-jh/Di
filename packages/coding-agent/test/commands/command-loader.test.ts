import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBuiltinCommands,
  createBuiltinRegistry,
  loadCommandsInto,
  StringCommandOutput,
  type CommandContext,
  type CommandHost,
  type SlashCommandRegistry,
} from "@di/coding-agent";
import { RecordingHost } from "./test-doubles.ts";

/**
 * P6.3a card — user-command loader (port of C# `CommandLoaderTests.cs`):
 * `~/.di/commands/*.md → registry`; temp-directory style mirrors
 * `SkillRepositoryTests` (invalid-file warn-skip / duplicate-name warn-skip /
 * missing directory never crashes).
 */

const ROOT = "di-commands-";

let root = "";
let warnings: string[] = [];
let registry: SlashCommandRegistry;

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), ROOT));
  warnings = [];
  registry = createBuiltinRegistry();
});

test.afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* cleanup failure ignored */
  }
});

const commandsDir = (): string => join(root, "commands");
const builtinCount = createBuiltinCommands().length;

function writeCommand(name: string, description: string, body = "body"): void {
  mkdirSync(commandsDir(), { recursive: true });
  writeFileSync(join(commandsDir(), `${name}.md`), `---\ndescription: ${description}\n---\n${body}`);
}

function makeContext(): CommandContext {
  const host: CommandHost = new RecordingHost();
  return {
    registry,
    host,
    skills: [],
    pinned: [],
    output: new StringCommandOutput(),
    useAnsi: true,
  };
}

test("load missing dir loads nothing", () => {
  assert.equal(loadCommandsInto(registry, commandsDir(), (w) => warnings.push(w)), 0);
  assert.equal(registry.list().length, builtinCount); // builtins only
});

test("load valid commands become turn commands", async () => {
  writeCommand("commit", "提交改动", "git add -A && git commit");

  assert.equal(loadCommandsInto(registry, commandsDir(), (w) => warnings.push(w)), 1);
  assert.deepEqual(warnings, []);
  const cmd = registry.tryGet("commit");
  assert.ok(cmd !== undefined, "user command /commit should be registered");

  const ctx = makeContext();
  const result = await cmd.handler("第一个提交", ctx);

  assert.ok(result.turnMessage !== undefined);
  assert.ok(result.turnMessage!.includes("git add -A && git commit"));
  assert.ok(result.turnMessage!.includes("第一个提交"));
});

test("load user commands merge with builtins", () => {
  writeCommand("commit", "提交改动");

  loadCommandsInto(registry, commandsDir(), (w) => warnings.push(w));

  assert.equal(registry.list().length, builtinCount + 1);
  assert.ok(registry.list().some((c) => c.name === "commit"));
});

test("load name conflict with builtin warns and skips", () => {
  writeCommand("model", "不该覆盖内置");

  assert.equal(loadCommandsInto(registry, commandsDir(), (w) => warnings.push(w)), 0);
  assert.ok(warnings.some((w) => w.includes("重名")));
  const builtin = registry.tryGet("model");
  assert.ok(builtin !== undefined);
  assert.equal(builtin.description, "查看或切换模型"); // builtin wins
});

test("load invalid file warns and skips", () => {
  mkdirSync(commandsDir(), { recursive: true });
  writeFileSync(join(commandsDir(), "broken.md"), "not frontmatter");

  assert.equal(loadCommandsInto(registry, commandsDir(), (w) => warnings.push(w)), 0);
  assert.ok(warnings.some((w) => w.includes("跳过无效命令")));
});
