import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LineTextReader, SessionStore, StringTextWriter } from "@di/coding-agent";
import type { ModelSelectionHost, TurnRunner } from "@di/coding-agent";
import type { UsageCost } from "@di/ai";
import { runRpcMode } from "@di/coding-agent";
import {
  BlockingRunner,
  buildHost,
  ClearHistoryRunner,
  DeltaRunner,
  ErrorRunner,
  FakeRunner,
  inputLines,
  makeArgs,
  outputLines,
  skill,
  SoftStopRunner,
  ThrowingRunner,
  ToolRunner,
} from "./test-host.ts";
import type { BuildHostOptions } from "./test-host.ts";

/**
 * P6.3c card — rpc mode (--mode rpc, NDJSON over stdin/stdout), port of C#
 * `Di.Cli.Tests/modes/RpcModeTests.cs` at baseline 09f4e08 against docs/tui-rpc.md:
 * ready handshake, prompt event stream + result, interrupt → cancelled, soft-stop →
 * interrupted, set_model / set_skills / clear_history / ping, the command system
 * (list / run / turn_not_supported / pinned persistence), failure-is-a-message
 * (parse_error / invalid_request / run_failed→result error), session log best-effort,
 * plus the P6.3c busy envelope (set_model and command model/thinking while a turn
 * is running → busy).
 */

async function runRpc<T extends TurnRunner & ModelSelectionHost = FakeRunner>(
  args: Parameters<typeof makeArgs>[0],
  input: string,
  hostOverrides: BuildHostOptions & { runner?: T } = {},
) {
  const stdout = new StringTextWriter();
  const stderr = new StringTextWriter();
  const { host, runner } = buildHost<T>(hostOverrides);
  const code = await runRpcMode(host, makeArgs(args), new LineTextReader(inputLines(input)), stdout, stderr);
  return { code, stdout, stderr, runner };
}

// ---- 握手与退出 ----

test("Rpc_EmitsReadyFirst_ThenShutdownExitsZero", async () => {
  const { code, stdout, stderr } = await runRpc({}, '{"type":"request","id":1,"method":"shutdown","params":{}}');

  assert.equal(code, 0);
  const lines = outputLines(stdout.text());
  assert.equal(lines[0], '{"type":"ready","version":"0.1.0","model":"deepseek-flash","skills":[],"models":[]}');
  assert.equal(lines.length, 1); // shutdown 无应答，仅 ready
  assert.equal(stderr.text(), "");
});

test("Rpc_Ready_EmitsModelEffortSkillsModels", async () => {
  // ready 握手携带当前模型/强度/skills/模型目录快照，TUI 据此渲染右下角状态栏与命令补全。
  const service = {
    listProviders: () => [],
    listModels: () => [
      { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash" },
      { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek Pro" },
    ],
    refreshModels: async () => [],
    checkAuth: async () => true,
    resolveModel: async (provider: string, id: string) => ({ provider, id, name: id }),
  };
  const { code, stdout } = await runRpc(
    {},
    '{"type":"request","id":1,"method":"shutdown","params":{}}',
    { service, skills: [skill("backend-tests", "跑后端测试", "dotnet test")], reasoningEffort: "high" },
  );

  assert.equal(code, 0);
  const doc = JSON.parse(outputLines(stdout.text())[0]!);
  assert.equal(doc.type, "ready");
  assert.equal(doc.model, "deepseek-flash");
  assert.equal(doc.effort, "high");
  assert.equal(doc.skills.length, 1);
  assert.equal(doc.skills[0].name, "backend-tests");
  assert.equal(doc.skills[0].description, "跑后端测试");
  assert.equal(doc.models.length, 2);
  assert.equal(doc.models[0].id, "deepseek/deepseek-flash");
  assert.equal(doc.models[0].name, "DeepSeek Flash");
  assert.equal(doc.models[1].id, "deepseek/deepseek-v4-pro");
});

test("Rpc_Eof_ExitsZero_WithoutRunningTurn", async () => {
  const { code, stdout, runner } = await runRpc({}, "");

  assert.equal(code, 0);
  assert.deepEqual(runner.messages, []);
  assert.equal(outputLines(stdout.text())[0], '{"type":"ready","version":"0.1.0","model":"deepseek-flash","skills":[],"models":[]}');
});

// ---- prompt：事件流 + result ----

const PROMPT_SHUTDOWN = `
{"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
{"type":"request","id":2,"method":"shutdown","params":{}}
`;

test("Rpc_Prompt_EmitsEventsThenResult_ExitsZero", async () => {
  const { code, stdout, stderr, runner } = await runRpc({}, PROMPT_SHUTDOWN);

  assert.equal(code, 0);
  assert.deepEqual(runner.messages, ["hi"]);
  const lines = outputLines(stdout.text());
  assert.equal(lines[0], '{"type":"ready","version":"0.1.0","model":"deepseek-flash","skills":[],"models":[]}');

  const evt1 = JSON.parse(lines[1]!);
  assert.equal(evt1.type, "event");
  assert.equal(evt1.seq, 1);
  assert.equal(evt1.event.kind, "text_delta");
  assert.equal(evt1.event.delta, "回答: hi");

  const evt2 = JSON.parse(lines[2]!);
  assert.equal(evt2.event.kind, "turn_completed");
  assert.equal(evt2.event.iteration, 1);
  assert.equal(evt2.event.usage.input_tokens, 10);
  assert.equal(evt2.event.usage.output_tokens, 20);
  assert.ok(!("total_tokens" in evt2.event.usage), "null 键省略");
  assert.ok(!("cost" in evt2.event), "cost 为 null 时省略键");
  assert.equal(evt2.event.finish_reason, "stop");

  const result = JSON.parse(lines[3]!);
  assert.equal(result.type, "result");
  assert.equal(result.seq, 3);
  assert.equal(result.result.answer, "回答: hi");
  assert.equal(result.result.stop_reason, "answer");
  assert.equal(result.result.iterations, 1);
  assert.equal(result.result.usage.input_tokens, 10);
  assert.equal(stderr.text(), "");
});

test("Rpc_Prompt_EmitsExactWireSequence", async () => {
  // 字节级契约锚定：ready → text_delta → turn_completed → result 的完整线序与字段名。
  const { code, stdout } = await runRpc({}, PROMPT_SHUTDOWN);

  assert.equal(code, 0);
  const expected =
    '{"type":"ready","version":"0.1.0","model":"deepseek-flash","skills":[],"models":[]}\n' +
    '{"type":"event","seq":1,"event":{"kind":"text_delta","delta":"回答: hi"}}\n' +
    '{"type":"event","seq":2,"event":{"kind":"turn_completed","iteration":1,"usage":{"input_tokens":10,"output_tokens":20},"finish_reason":"stop"}}\n' +
    '{"type":"result","seq":3,"result":{"answer":"回答: hi","stop_reason":"answer","iterations":1,"usage":{"input_tokens":10,"output_tokens":20}}}\n';
  assert.equal(stdout.text(), expected);
});

test("Rpc_Prompt_CostPresent_SerializedAsNumber", async () => {
  const cost: UsageCost = { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 }; // total = 0.3
  const runner = new FakeRunner();
  runner.cost = cost;
  const { stdout } = await runRpc({}, PROMPT_SHUTDOWN, { runner });

  const lines = outputLines(stdout.text());
  const result = JSON.parse(lines[lines.length - 1]!);
  assert.ok(Math.abs(result.result.cost - 0.3) < 1e-9, "cost 应为 0.3（浮点容差内）");
});

test("Rpc_ReasoningAndToolCallDeltas_EmittedAsDeltaEvents", async () => {
  const { code, stdout } = await runRpc({}, PROMPT_SHUTDOWN, { runner: new DeltaRunner() });

  assert.equal(code, 0);
  const lines = outputLines(stdout.text());

  const reason = JSON.parse(lines[1]!);
  assert.equal(reason.event.kind, "reasoning_delta");
  assert.equal(reason.event.delta, "思考中");

  const call = JSON.parse(lines[2]!);
  assert.equal(call.event.kind, "tool_call_delta");
  assert.equal(call.event.id, "c1");
  assert.equal(call.event.name, "echo");
  assert.equal(call.event.arguments, '{"x":1}');

  const turn = JSON.parse(lines[3]!);
  assert.equal(turn.event.kind, "turn_completed");
  assert.equal(turn.event.usage.reasoning_tokens, 5);
});

test("Rpc_ToolLifecycle_EmittedAsToolStartedAndCompleted", async () => {
  const { code, stdout } = await runRpc({}, PROMPT_SHUTDOWN, { runner: new ToolRunner() });

  assert.equal(code, 0);
  const lines = outputLines(stdout.text());

  const started = JSON.parse(lines[1]!);
  assert.equal(started.event.kind, "tool_started");
  assert.equal(started.event.call.name, "echo");

  const completed = JSON.parse(lines[2]!);
  assert.equal(completed.event.kind, "tool_completed");
  assert.equal(completed.event.observation, "obs");
  assert.equal(completed.event.is_error, false);
});

// ---- interrupt ----

test("Rpc_InterruptDuringTurn_EmitsResultCancelled_ExitsZero", async () => {
  const { code, stdout } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
{"type":"request","id":2,"method":"interrupt","params":{}}
`,
    { runner: new BlockingRunner() },
  );

  assert.equal(code, 0);
  const lines = outputLines(stdout.text());
  const result = JSON.parse(lines[lines.length - 1]!);
  assert.equal(result.type, "result");
  assert.equal(result.result.stop_reason, "cancelled");
});

test("Rpc_SoftStoppedTurn_EmitsResultInterrupted", async () => {
  // 软停止（Interrupted）是正常收敛：result.stop_reason = "interrupted"（区别于硬取消的 "cancelled"）。
  const { code, stdout } = await runRpc(
    {},
    '{"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}',
    { runner: new SoftStopRunner() },
  );

  assert.equal(code, 0);
  const lines = outputLines(stdout.text());
  const result = JSON.parse(lines[lines.length - 1]!);
  assert.equal(result.type, "result");
  assert.equal(result.result.stop_reason, "interrupted");
});

// ---- 会话级命令 ----

test("Rpc_SetModel_ChangesCurrentModel", async () => {
  const { code, runner } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"set_model","params":{"model":"deepseek/deepseek-v4-pro"}}
{"type":"request","id":2,"method":"shutdown","params":{}}
`,
  );

  assert.equal(code, 0);
  assert.equal(runner.currentModel, "deepseek-v4-pro");
});

test("Rpc_SetSkills_ResolvesNamesToKnownSkills", async () => {
  const { code, runner } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"set_skills","params":{"names":["backend-tests","不存在"]}}
{"type":"request","id":2,"method":"shutdown","params":{}}
`,
    { skills: [skill("backend-tests", "跑后端测试", "dotnet test")] },
  );

  assert.equal(code, 0);
  assert.deepEqual(runner.activeSkills.map((s) => s.name), ["backend-tests"]); // 未知名被过滤
});

test("Rpc_ClearHistory_CallsResetHistory", async () => {
  const { code, runner } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"clear_history","params":{}}
{"type":"request","id":2,"method":"shutdown","params":{}}
`,
    { runner: new ClearHistoryRunner() },
  );

  assert.equal(code, 0);
  assert.equal(runner.resetCalls, 1);
});

test("Rpc_Ping_ProducesNoReply", async () => {
  const { code, stdout } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"ping","params":{}}
{"type":"request","id":2,"method":"shutdown","params":{}}
`,
  );

  assert.equal(code, 0);
  assert.equal(outputLines(stdout.text()).length, 1); // 仅 ready，ping 无应答
});

// ---- 失败路径 ----

test("Rpc_RunnerThrows_EmitsResultError_ExitsZero", async () => {
  const { code, stdout } = await runRpc({}, PROMPT_SHUTDOWN, { runner: new ThrowingRunner() });

  assert.equal(code, 0); // 回合失败是消息不是崩溃：进程仍优雅退出 0
  const lines = outputLines(stdout.text());
  const result = JSON.parse(lines[lines.length - 1]!);
  assert.equal(result.result.stop_reason, "error");
  assert.equal(result.result.failure.code, "model_error");
  assert.ok(result.result.failure.message.includes("boom"));
});

test("Rpc_StopReasonError_EmitsResultErrorWithFailure", async () => {
  const { code, stdout } = await runRpc({}, PROMPT_SHUTDOWN, { runner: new ErrorRunner() });

  assert.equal(code, 0);
  const lines = outputLines(stdout.text());
  const result = JSON.parse(lines[lines.length - 1]!);
  assert.equal(result.result.stop_reason, "error");
  assert.equal(result.result.failure.code, "missing_credential");
  assert.ok(result.result.failure.message.includes("API Key"));
});

test("Rpc_MalformedJson_EmitsParseError_Continues", async () => {
  const { code, stdout, runner } = await runRpc(
    {},
    `
not-json
{"type":"request","id":2,"method":"shutdown","params":{}}
`,
  );

  assert.equal(code, 0);
  assert.deepEqual(runner.messages, []); // 解析失败不触发回合
  const lines = outputLines(stdout.text());
  const err = JSON.parse(lines[1]!);
  assert.equal(err.type, "error");
  assert.equal(err.code, "parse_error");
});

test("Rpc_MissingParams_EmitsInvalidRequest_Continues", async () => {
  const { code, stdout, runner } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"prompt"}
{"type":"request","id":2,"method":"shutdown","params":{}}
`,
  );

  assert.equal(code, 0);
  assert.deepEqual(runner.messages, []);
  const lines = outputLines(stdout.text());
  const err = JSON.parse(lines[1]!);
  assert.equal(err.code, "invalid_request");
});

test("Rpc_UnknownMethod_EmitsError_Continues", async () => {
  const { code, stdout } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"bogus","params":{}}
{"type":"request","id":2,"method":"shutdown","params":{}}
`,
  );

  assert.equal(code, 0);
  const lines = outputLines(stdout.text());
  const err = JSON.parse(lines[1]!);
  assert.equal(err.code, "unknown_method");
});

// ---- 会话日志 ----

test("Rpc_WritesSessionLog_ByDefault", async () => {
  const root = mkdtempSync(join(tmpdir(), "di-rpc-session-"));
  try {
    const sessionStore = new SessionStore({ rootDirectory: root });
    const { code } = await runRpc({}, PROMPT_SHUTDOWN, { sessionStore });

    assert.equal(code, 0);
    const lines = readFileSync(sessionStore.logFilePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    assert.equal(JSON.parse(lines[lines.length - 1]!).payload.type, "task_complete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Rpc_NoSession_SkipsWritingLog", async () => {
  const root = mkdtempSync(join(tmpdir(), "di-rpc-nosession-"));
  try {
    const sessionStore = new SessionStore({ rootDirectory: root });
    const { code } = await runRpc({ noSession: true }, PROMPT_SHUTDOWN, { sessionStore });

    assert.equal(code, 0);
    let exists = false;
    try {
      exists = readFileSync(sessionStore.logFilePath, "utf8").length > 0;
    } catch {
      exists = false;
    }
    assert.ok(!exists, "--no-session 不应创建会话文件");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 命令系统（docs/tui-rpc.md §3 command 方法） ----

test("Rpc_Command_List_EmitsCommandListed", async () => {
  const { code, stdout } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"command","params":{"list":true}}
{"type":"request","id":2,"method":"shutdown","params":{}}
`,
  );

  assert.equal(code, 0);
  const lines = outputLines(stdout.text());
  assert.equal(lines[0], '{"type":"ready","version":"0.1.0","model":"deepseek-flash","skills":[],"models":[]}');
  const doc = JSON.parse(lines[1]!);
  assert.equal(doc.type, "command_listed");
  assert.ok(doc.commands.length >= 6, "应列出全部内置命令");
  assert.ok("name" in doc.commands[0]);
  assert.ok("description" in doc.commands[0]);
});

test("Rpc_Command_RunModel_EmitsLines_AndApplies", async () => {
  const { code, stdout, runner } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"command","params":{"name":"model","args":"deepseek/deepseek-v4-pro"}}
{"type":"request","id":2,"method":"shutdown","params":{}}
`,
  );

  assert.equal(code, 0);
  assert.equal(runner.currentModel, "deepseek-v4-pro"); // 命令真实生效
  const lines = outputLines(stdout.text());
  const doc = JSON.parse(lines[1]!);
  assert.equal(doc.type, "command_ran");
  assert.equal(doc.name, "model");
  assert.ok(doc.lines.some((l: string) => l.includes("模型已切换为 deepseek-v4-pro")));
  assert.equal(doc.exit, false);
  // 应答携带切换后的模型/强度快照，TUI 据此更新右下角状态栏。
  assert.equal(doc.model, "deepseek-v4-pro");
});

test("Rpc_Command_Unknown_EmitsCommandError", async () => {
  const { code, stdout } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"command","params":{"name":"bogus"}}
{"type":"request","id":2,"method":"shutdown","params":{}}
`,
  );

  assert.equal(code, 0);
  const doc = JSON.parse(outputLines(stdout.text())[1]!);
  assert.equal(doc.type, "command_error");
  assert.equal(doc.code, "unknown_command");
});

test("Rpc_Command_MissingName_EmitsInvalidRequest", async () => {
  const { code, stdout } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"command","params":{}}
{"type":"request","id":2,"method":"shutdown","params":{}}
`,
  );

  assert.equal(code, 0);
  const doc = JSON.parse(outputLines(stdout.text())[1]!);
  assert.equal(doc.type, "command_error");
  assert.equal(doc.code, "invalid_request");
});

test("Rpc_Command_TurnCommand_EmitsTurnNotSupported", async () => {
  const { code, stdout } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"command","params":{"name":"skill","args":"backend-tests 补测试"}}
{"type":"request","id":2,"method":"shutdown","params":{}}
`,
    { skills: [skill("backend-tests", "跑后端测试", "dotnet test")] },
  );

  assert.equal(code, 0);
  const doc = JSON.parse(outputLines(stdout.text())[1]!);
  assert.equal(doc.type, "command_error");
  assert.equal(doc.code, "turn_not_supported");
  // turn_message 携带指令+参数全文，TUI 据此改用自身 prompt 机制跑回合（docs/tui-rpc.md §2.5）。
  assert.ok(doc.turn_message.includes("【Skill：backend-tests】"));
  assert.ok(doc.turn_message.includes("补测试"));
});

test("Rpc_Command_PinnedSkills_PersistAcrossCalls", async () => {
  const { code, stdout } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"command","params":{"name":"skill","args":"backend-tests"}}
{"type":"request","id":2,"method":"command","params":{"name":"skills"}}
{"type":"request","id":3,"method":"shutdown","params":{}}
`,
    { skills: [skill("backend-tests", "跑后端测试", "dotnet test")] },
  );

  assert.equal(code, 0);
  const lines = outputLines(stdout.text());
  const ran = JSON.parse(lines[1]!);
  assert.equal(ran.type, "command_ran"); // 固定成功

  const listed = JSON.parse(lines[2]!);
  // 第二次调用仍看到固定标记（跨命令保持）；行首带缩进空格，按子串判断。
  assert.ok(listed.lines.some((l: string) => l.includes("[*] backend-tests")));
});

test("Rpc_Prompt_RecomputesAutoSkills_AndPreservesExplicitSkills", async () => {
  const auto = skill("python", "python", "use python");
  const pinned = skill("fixed", "fixed", "fixed");
  const runner = new ClearHistoryRunner();
  await runRpc(
    { noSession: true },
    `
{"method":"set_skills","params":{"names":["fixed"]}}
{"method":"prompt","params":{"message":"python"}}
{"method":"prompt","params":{"message":"hello"}}
{"method":"command","params":{"name":"skill","args":"fixed"}}
{"method":"prompt","params":{"message":"hello"}}
{"method":"command","params":{"name":"skill","args":"fixed"}}
{"method":"prompt","params":{"message":"hello"}}
`,
    { skills: [auto, pinned], runner },
  );
  assert.deepEqual(runner.skillSnapshots[0]!.map((s) => s.name), ["fixed", "python"]);
  assert.deepEqual(runner.skillSnapshots[1]!.map((s) => s.name), ["fixed"]);
  assert.deepEqual(runner.skillSnapshots[2]!.map((s) => s.name), []);
  assert.deepEqual(runner.skillSnapshots[3]!.map((s) => s.name), ["fixed"]);
});

// ---- P6.3c busy envelope：回合进行中拒绝模型/强度修改 ----

test("Rpc_SetModel_Busy_EmitsErrorBusy", async () => {
  const { code, stdout } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
{"type":"request","id":2,"method":"set_model","params":{"model":"deepseek/deepseek-v4-pro"}}
{"type":"request","id":3,"method":"interrupt","params":{}}
`,
    { runner: new BlockingRunner() },
  );

  assert.equal(code, 0);
  const lines = outputLines(stdout.text());
  const err = JSON.parse(lines[1]!);
  assert.equal(err.type, "error");
  assert.equal(err.code, "busy");
  assert.ok(err.message.includes("等待当前回合结束"));
});

test("Rpc_Command_Busy_EmitsCommandErrorBusy", async () => {
  const { code, stdout } = await runRpc(
    {},
    `
{"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
{"type":"request","id":2,"method":"command","params":{"name":"model","args":"deepseek/deepseek-v4-pro"}}
{"type":"request","id":3,"method":"interrupt","params":{}}
`,
    { runner: new BlockingRunner() },
  );

  assert.equal(code, 0);
  const lines = outputLines(stdout.text());
  const err = JSON.parse(lines[1]!);
  assert.equal(err.type, "command_error");
  assert.equal(err.code, "busy");
});
