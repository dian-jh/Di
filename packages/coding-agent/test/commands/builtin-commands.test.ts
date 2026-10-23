import test from "node:test";
import assert from "node:assert/strict";
import {
  createBuiltinRegistry,
  ModelSelection,
  StringCommandOutput,
  type CommandContext,
  type Skill,
  type SlashCommand,
  type SlashCommandRegistry,
} from "@di/coding-agent";
import { FakeAdapter, FakeModelService, RecordingHost, testSkill } from "./test-doubles.ts";

/**
 *
 * mode-agnostic handler set (exit/help/clear/model/thinking/usage/skills/skill)
 * reached only through the {@link CommandContext} — REPL and RPC share the same
 * registered content.
 */

let registry: SlashCommandRegistry;
let runner: RecordingHost;
let pinned: Skill[];
let output: StringCommandOutput;
let models: ModelSelection;
let turns: string[];

test.beforeEach(() => {
  registry = createBuiltinRegistry();
  runner = new RecordingHost();
  pinned = [];
  output = new StringCommandOutput();
  turns = [];
  const service = new FakeModelService();
  service.register(
    new FakeAdapter("deepseek", [
      { id: "deepseek-flash", name: "Flash" },
      { id: "deepseek-chat", name: "DeepSeek Chat" },
    ]),
  );
  models = new ModelSelection(service, runner);
});

function makeContext(skills: readonly Skill[] = [testSkill]): CommandContext {
  return {
    registry,
    host: runner,
    skills,
    pinned,
    output,
    useAnsi: true,
    runTurn: (message) => {
      turns.push(message);
    },
    models,
  };
}

function cmd(name: string): SlashCommand {
  const found = registry.tryGet(name);
  assert.ok(found !== undefined, `command /${name} should be registered`);
  return found;
}

test("all builtins registered", () => {
  assert.deepEqual(
    registry.list().map((c) => c.name),
    ["clear", "exit", "help", "model", "skill", "skills", "thinking", "usage"],
  );
});

test("exit requests quit no turn", async () => {
  const result = await cmd("exit").handler("", makeContext());

  assert.equal(result.exit, true);
  assert.equal(result.turnMessage, undefined);
  assert.deepEqual(turns, []);
});

test("help text derived from registry", async () => {
  await cmd("help").handler("", makeContext());

  const text = output.toString();
  assert.ok(text.includes("可用命令"));
  assert.ok(text.includes("/model [provider/model | 名称 | --refresh] —— 查看或切换模型"));
  assert.ok(text.includes("/exit —— 退出 Di"));
});

test("clear resets history and clears screen with ansi", async () => {
  const result = await cmd("clear").handler("", makeContext());

  assert.equal(result.exit, false);
  assert.equal(runner.resetCalls, 1);
  assert.ok(output.toString().includes("\x1b[2J"));
});

test("clear no ansi omits escape sequences", async () => {
  const ctx: CommandContext = {
    registry,
    host: runner,
    skills: [],
    pinned: [],
    output,
    useAnsi: false,
    models,
  };
  await cmd("clear").handler("", ctx);

  assert.equal(runner.resetCalls, 1);
  assert.ok(!output.toString().includes("\x1b["));
  assert.ok(output.toString().includes("已清空屏幕与对话记忆"));
});

test("model with args switches model", async () => {
  await cmd("model").handler("deepseek-chat", makeContext());

  assert.equal(runner.currentModel, "deepseek-chat");
  assert.ok(output.toString().includes("模型已切换为 deepseek-chat"));
});

test("model without args shows usage model unchanged", async () => {
  await cmd("model").handler("", makeContext());

  assert.equal(runner.currentModel, "deepseek-flash");
  assert.ok(output.toString().includes("用法: /model"));
});

test("skills lists pinned with marker", async () => {
  pinned.push(testSkill);

  await cmd("skills").handler("", makeContext());

  assert.ok(output.toString().includes("[*] backend-tests —— 跑后端测试"));
});

test("skills empty shows hint", async () => {
  await cmd("skills").handler("", makeContext([]));

  assert.ok(output.toString().includes("没有可用 skill"));
});

test("skill toggle pins then unpins", async () => {
  await cmd("skill").handler("backend-tests", makeContext());
  assert.ok(pinned.includes(testSkill));
  assert.deepEqual(runner.activeSkillNames, ["backend-tests"]);

  await cmd("skill").handler("backend-tests", makeContext());
  assert.ok(!pinned.includes(testSkill));
  assert.deepEqual(runner.activeSkillNames, []);
});

test("skill off clears all", async () => {
  pinned.push(testSkill);

  await cmd("skill").handler("off", makeContext());

  assert.deepEqual(pinned, []);
  assert.deepEqual(runner.activeSkillNames, []);
  assert.ok(output.toString().includes("已停用全部 skill"));
});

test("skill unknown reports not found", async () => {
  await cmd("skill").handler("nope", makeContext());

  assert.ok(output.toString().includes("未找到 skill：nope"));
});

test("skill with args runs turn without pinning", async () => {
  const result = await cmd("skill").handler("backend-tests 帮我补测试", makeContext());

  assert.equal(result.exit, false);
  assert.ok(result.turnMessage !== undefined);
  assert.ok(result.turnMessage!.includes("【Skill：backend-tests】"));
  assert.ok(result.turnMessage!.includes("npm test"));
  assert.ok(result.turnMessage!.includes("帮我补测试"));
  assert.ok(!pinned.includes(testSkill)); // one-shot execution does not pin
  assert.deepEqual(turns, []); // the host executes the turn; the command itself does not
});

test("thinking shows current reasoning effort", async () => {
  await cmd("thinking").handler("", makeContext());

  assert.ok(output.toString().includes("推理强度: default"));
  assert.ok(output.toString().includes("目录未提供模型专属档位"));
});
