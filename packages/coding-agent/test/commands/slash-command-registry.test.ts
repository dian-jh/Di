import test from "node:test";
import assert from "node:assert/strict";
import { HANDLED, SlashCommandRegistry, type SlashCommand } from "@di/coding-agent";

/**
 *
 * register / list / duplicate / resolve / input split / help derivation. The
 * registry is the seam REPL/print/JSON/RPC modes share (same registry, same
 * handler functions).
 */

const cmd = (name: string): SlashCommand => ({
  name,
  description: `${name} 的描述`,
  handler: () => HANDLED,
});

test("register and list sorts by name", () => {
  const registry = new SlashCommandRegistry();
  registry.register(cmd("model"));
  registry.register(cmd("clear"));

  assert.deepEqual(
    registry.list().map((c) => c.name),
    ["clear", "model"],
  );
});

test("register duplicate throws", () => {
  const registry = new SlashCommandRegistry();
  registry.register(cmd("model"));

  assert.throws(() => registry.register(cmd("model")));
});

test("registerAll registers every command", () => {
  const registry = new SlashCommandRegistry();
  registry.registerAll([cmd("exit"), cmd("help")]);

  assert.equal(registry.list().length, 2);
});

test("register blank name throws", () => {
  const registry = new SlashCommandRegistry();

  assert.throws(() => registry.register(cmd(" ")));
});

test("tryGet hit and miss", () => {
  const registry = new SlashCommandRegistry();
  registry.register(cmd("exit"));

  assert.equal(registry.tryGet("exit")?.name, "exit");
  assert.equal(registry.tryGet("nope"), undefined);
});

test("split keeps slash and trims args", () => {
  assert.deepEqual(SlashCommandRegistry.split("/model deepseek-chat"), { name: "/model", args: "deepseek-chat" });
  assert.deepEqual(SlashCommandRegistry.split("/exit"), { name: "/exit", args: "" });
  assert.deepEqual(SlashCommandRegistry.split("/skill  backend-tests  "), { name: "/skill", args: "backend-tests" });
});

test("format includes hint only when present", () => {
  const withHint: SlashCommand = {
    name: "model",
    description: "切换模型",
    argumentHint: "<模型名>",
    handler: () => HANDLED,
  };

  assert.equal(SlashCommandRegistry.format(withHint), "  /model <模型名> —— 切换模型");
  assert.equal(SlashCommandRegistry.format(cmd("exit")), "  /exit —— exit 的描述");
});

test("buildHelp lists all registered", () => {
  const registry = new SlashCommandRegistry();
  registry.register(cmd("exit"));
  registry.register(cmd("clear"));

  const help = registry.buildHelp();
  assert.ok(help.includes("可用命令"));
  assert.ok(help.includes("/clear"));
  assert.ok(help.includes("/exit"));
});
