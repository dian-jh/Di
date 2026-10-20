import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore, StringTextWriter, nullTextReader } from "@di/coding-agent";
import type { ModelSelectionHost, TurnRunner } from "@di/coding-agent";
import type { UsageCost } from "@di/ai";
import { runJsonMode } from "@di/coding-agent";
import { buildHost, ErrorRunner, FakeRunner, makeArgs, skill, ThrowingRunner } from "./test-host.ts";
import type { BuildHostOptions } from "./test-host.ts";

/**
 * P6.3c card — json mode (headless single JSON document), port of the JSON half of C#
 * `Di.Cli.Tests/modes/PrintModeTests.cs` at baseline 09f4e08. No event streaming: exactly one
 * parseable JSON doc on stdout; `{"error": {"code": ..., "message": ...}}` envelopes exit 1 on
 * usage / model error; nullable keys (cost) are omitted, never written as null.
 */

async function run<T extends TurnRunner & ModelSelectionHost = FakeRunner>(
  args: Parameters<typeof makeArgs>[0],
  hostOverrides: BuildHostOptions & { runner?: T } = {},
) {
  const stdout = new StringTextWriter();
  const stderr = new StringTextWriter();
  const { host, runner } = buildHost<T>(hostOverrides);
  const code = await runJsonMode(host, makeArgs(args), nullTextReader, stdout, stderr);
  return { code, stdout, stderr, runner };
}

test("Json_EmitsParseableDoc_WithAnswerStopReasonIterationsUsage_ExitsZero", async () => {
  const { code, stdout, stderr } = await run({ mode: "json", positionals: ["分析"] });

  assert.equal(code, 0);
  const doc = JSON.parse(stdout.text());
  assert.equal(doc.answer, "回答: 分析");
  assert.equal(doc.stop_reason, "answer");
  assert.equal(doc.iterations, 1);
  assert.equal(doc.usage.input_tokens, 10);
  assert.equal(doc.usage.output_tokens, 20);
  assert.equal(stderr.text(), "");
});

test("Json_CostNull_OmittedFromDoc", async () => {
  // FakeRunner.Cost 默认 undefined → cost 键应省略，而非输出 null。
  const { stdout } = await run({ mode: "json", positionals: ["hi"] });

  const doc = JSON.parse(stdout.text());
  assert.ok(!("cost" in doc), "cost 为 null 时应省略键，而非输出 null");
});

test("Json_CostPresent_SerializedAsNumber", async () => {
  const cost: UsageCost = { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 }; // total = 0.3
  const runner = new FakeRunner();
  runner.cost = cost;
  const { stdout } = await run({ mode: "json", positionals: ["hi"] }, { runner });

  const doc = JSON.parse(stdout.text());
  assert.ok(Math.abs(doc.cost - 0.3) < 1e-9, "cost 应为 0.3（浮点容差内）");
});

test("Json_DoesNotStreamEvents_OnlySingleDoc", async () => {
  const { stdout } = await run({ mode: "json", positionals: ["hi"] });

  const text = stdout.text();
  assert.ok(!text.includes("思考完成"), "JSON 模式不写人类可读事件");
  assert.ok(!text.trim().includes("\n"), "且只输出一个 JSON 文档");
});

test("Json_AutoActivatesMatchingSkill_SetsActiveSkills", async () => {
  const skills = [skill("backend-tests", "运行并修复后端测试（dotnet）。当用户要求运行测试、分析失败或修复测试时使用。")];
  const { code, runner } = await run({ mode: "json", positionals: ["跑一下后端测试"] }, { skills });

  assert.equal(code, 0);
  assert.deepEqual(runner.activeSkills.map((s) => s.name), ["backend-tests"]);
});

test("Json_EmptyPrompt_EmitsErrorDoc_ExitsOne", async () => {
  const { code, stdout, runner } = await run({ mode: "json" });

  assert.equal(code, 1);
  assert.deepEqual(runner.messages, []);
  const doc = JSON.parse(stdout.text());
  assert.equal(doc.error.code, "usage");
  assert.ok(doc.error.message.includes("提示词"));
});

test("Json_RunnerThrows_EmitsErrorDoc_ExitsOne", async () => {
  const { code, stdout } = await run({ mode: "json", positionals: ["hi"] }, { runner: new ThrowingRunner() });

  assert.equal(code, 1);
  const doc = JSON.parse(stdout.text());
  assert.equal(doc.error.code, "model_error");
});

test("Json_StopReasonError_EmitsErrorCode_ExitsOne", async () => {
  const { code, stdout } = await run({ mode: "json", positionals: ["hi"] }, { runner: new ErrorRunner() });

  assert.equal(code, 1);
  const doc = JSON.parse(stdout.text());
  assert.equal(doc.error.code, "missing_credential");
  assert.ok(doc.error.message.includes("API Key"));
});

test("Json_WritesSessionLog_ByDefault", async () => {
  const root = mkdtempSync(join(tmpdir(), "di-print-json-session-"));
  try {
    const sessionStore = new SessionStore({ rootDirectory: root });
    const { code } = await run({ mode: "json", positionals: ["hi"] }, { sessionStore });

    assert.equal(code, 0);
    const lines = readFileSync(sessionStore.logFilePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    assert.ok(lines.length >= 1, "json 模式默认也应写会话日志");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
