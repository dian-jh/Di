import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatModel, ContentBlock, ModelEvent, ModelRequest, ModelResponse } from "@di/ai";
import {
  DiHome,
  LocalAgentRunnerAdapter,
  StringTextWriter,
  createCliHost,
  createFileTools,
  type CliHost,
  type ModelInfo,
  type ModelSelectionHost,
  type ModelService,
  type ProviderInfo,
  type ResolvedModelInfo,
  type Skill,
  type TurnRunner,
} from "@di/coding-agent";
import { CommandError } from "di-tui";
import type { RpcAgentEvent, RpcAgentResult, RpcReadyMessage, RunnerPortHandlers } from "di-tui";
import { makeArgs, skill } from "../modes/test-host.ts";
import {
  BlockingRunner,
  buildHost,
  DeltaRunner,
  FakeRunner,
  FakeLlm,
  SoftStopRunner,
  ThrowingRunner,
  ToolRunner,
} from "../modes/test-host.ts";

/**
 *
 * in-process TUI runner must produce the SAME observable event sequence and wire
 * payload shapes (ready fields model/effort?/skills/models, snake_case,
 * null-keys-omitted, text/reasoning/tool_call deltas, tool lifecycle,
 * turn_completed/run_failed, result, cancelled/interrupted, list/run commands)
 * as the child-process `--mode rpc` path (docs/tui-rpc.md / tui protocol.ts
 *
 * fake suite mirrors test/modes/rpc-mode.test.ts, the real-host suite mirrors
 * test/cli/real-host-rpc.test.ts — same scenarios, same byte-level expectations
 * on both backends. Byte-level is interpreted as protocol-shape equivalence:
 * JSON.stringify(adapter event/result) == the RPC line payloads.
 */

/** Capture all handler callbacks into arrays (the wire observer). */
function capture(adapter: LocalAgentRunnerAdapter): {
  ready: RpcReadyMessage[];
  events: RpcAgentEvent[];
  results: RpcAgentResult[];
  errors: { message: string; code: string }[];
  stderr: string[];
} {
  const ready: RpcReadyMessage[] = [];
  const events: RpcAgentEvent[] = [];
  const results: RpcAgentResult[] = [];
  const errors: { message: string; code: string }[] = [];
  const stderr: string[] = [];
  const handlers: RunnerPortHandlers = {
    onReady: (meta) => ready.push(meta),
    onEvent: (event) => events.push(event),
    onResult: (result) => results.push(result),
    onError: (message, code) => errors.push({ message, code }),
    onStderr: (chunk) => stderr.push(chunk),
  };
  adapter.subscribe(handlers);
  return { ready, events, results, errors, stderr };
}

/** Build a fake host and a connected adapter with captured handlers. */
async function runAdapter<T extends TurnRunner & ModelSelectionHost = FakeRunner>(
  hostOverrides: Parameters<typeof buildHost<T>>[0] = {},
): Promise<{ host: CliHost; runner: T; adapter: LocalAgentRunnerAdapter } & ReturnType<typeof capture>> {
  const { host, runner } = buildHost<T>(hostOverrides);
  const adapter = new LocalAgentRunnerAdapter(host);
  const captured = capture(adapter);
  await adapter.connect();
  return { host, runner, adapter, ...captured };
}

// ---- 握手 ----

test("adapter connect: ready carries version/model/effort?/skills/models (byte-identical to RPC ready)", async () => {
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
  const { ready } = await runAdapter({
    service,
    skills: [skill("backend-tests", "跑后端测试", "npm test")],
    reasoningEffort: "high",
  });

  assert.equal(ready.length, 1);
  // 与 rpc-mode 的 ready 线字节级等价（Rpc_Ready_EmitsModelEffortSkillsModels）。
  assert.equal(JSON.stringify(ready[0]), '{"type":"ready","version":"0.1.0","model":"deepseek-flash","effort":"high","skills":[{"name":"backend-tests","description":"跑后端测试"}],"models":[{"id":"deepseek/deepseek-flash","name":"DeepSeek Flash"},{"id":"deepseek/deepseek-v4-pro","name":"DeepSeek Pro"}]}');
});

test("adapter connect: default no effort → ready omits the effort key", async () => {
  const { ready } = await runAdapter();
  assert.equal(ready.length, 1);
  assert.ok(!("effort" in ready[0]!), "默认无推理强度 → ready 无 effort 键");
  assert.deepEqual(ready[0]!.skills, []);
  assert.deepEqual(ready[0]!.models, []);
});

test("adapter connect: no handlers subscribed → connect rejects (contract: subscribe before connect)", async () => {
  const { host } = buildHost();
  const adapter = new LocalAgentRunnerAdapter(host);
  await assert.rejects(() => adapter.connect(), /未订阅 handlers/);
});

// ---- prompt：事件流 + result（字节级等价） ----

test("adapter prompt: emits exact text_delta → turn_completed → result wire (byte-identical to RPC)", async () => {
  const { adapter, events, results, runner } = await runAdapter();
  const result = await adapter.prompt("hi");

  assert.deepEqual((runner as FakeRunner).messages, ["hi"]);
  // 与 rpc-mode 的整线字节级等价（Rpc_Prompt_EmitsExactWireSequence 的 event/result 载荷）。
  assert.equal(JSON.stringify(events[0]), '{"kind":"text_delta","delta":"回答: hi"}');
  assert.equal(JSON.stringify(events[1]), '{"kind":"turn_completed","iteration":1,"usage":{"input_tokens":10,"output_tokens":20},"finish_reason":"stop"}');
  assert.equal(results.length, 1);
  assert.equal(JSON.stringify(results[0]), '{"answer":"回答: hi","stop_reason":"answer","iterations":1,"usage":{"input_tokens":10,"output_tokens":20}}');
  assert.equal(JSON.stringify(result), JSON.stringify(results[0]), "prompt() 与 onResult 收到同一 result");
});

test("adapter prompt: reasoning + tool_call deltas (byte-identical to RPC)", async () => {
  const { adapter, events } = await runAdapter({ runner: new DeltaRunner() });
  await adapter.prompt("hi");

  assert.equal(JSON.stringify(events[0]), '{"kind":"reasoning_delta","delta":"思考中"}');
  assert.equal(JSON.stringify(events[1]), '{"kind":"tool_call_delta","id":"c1","name":"echo","arguments":"{\\"x\\":1}"}');
  assert.equal((events[2]! as { usage: { reasoning_tokens: number } }).usage.reasoning_tokens, 5);
});

test("adapter prompt: tool lifecycle started/completed (byte-identical to RPC)", async () => {
  const { adapter, events } = await runAdapter({ runner: new ToolRunner() });
  await adapter.prompt("hi");

  const started = events[0]!;
  assert.equal(started.kind, "tool_started");
  assert.equal(started.call.name, "echo");
  const completed = events[1]!;
  assert.equal(completed.kind, "tool_completed");
  assert.equal(completed.observation, "obs");
  assert.equal(completed.is_error, false);
});

test("adapter prompt: soft-stop converges with result.stop_reason interrupted", async () => {
  const { adapter, results } = await runAdapter({ runner: new SoftStopRunner() });
  const result = await adapter.prompt("hi");
  assert.equal(result.stop_reason, "interrupted");
  assert.equal(results[0]!.stop_reason, "interrupted");
});

// ---- interrupt / 失败 ----

test("adapter interrupt: aborts the turn → result.stop_reason cancelled", async () => {
  const { adapter, results } = await runAdapter({ runner: new BlockingRunner() });
  const pending = adapter.prompt("hi");
  adapter.interrupt();
  const result = await pending;

  assert.equal(result.stop_reason, "cancelled");
  assert.equal(result.answer, "");
  assert.equal(result.iterations, 0);
  assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.stop_reason, "cancelled");
});

test("adapter prompt: a throwing runner digests to result.stop_reason error + failure (message not crash)", async () => {
  const { adapter, results } = await runAdapter({ runner: new ThrowingRunner() });
  const result = await adapter.prompt("hi");

  assert.equal(result.stop_reason, "error");
  assert.deepEqual(result.failure, { code: "model_error", message: "boom" });
  assert.equal(results.length, 1);
});

test("adapter prompt: busy rejects a second prompt while a turn is running", async () => {
  const { adapter } = await runAdapter({ runner: new BlockingRunner() });
  const pending = adapter.prompt("hi");
  await assert.rejects(() => adapter.prompt("second"), /busy/);
  adapter.interrupt();
  await pending;
  await adapter.stop();
});

// ---- 会话级操作 ----

test("adapter clearHistory: resets the runner history", async () => {
  const { adapter, runner } = await runAdapter();
  adapter.clearHistory();
  assert.equal((runner as FakeRunner).resetCalls, 1);
});

test("adapter setSkills: replaces the pinned/active skill set (only known skills)", async () => {
  const skills = [skill("a", "A"), skill("b", "B")];
  const { adapter, runner } = await runAdapter({ skills });
  adapter.setSkills(["a", "unknown"]);
  assert.deepEqual((runner as FakeRunner).activeSkills.map((s) => s.name), ["a"]);
});

test("adapter setModel: selects a catalog model and commits the label", async () => {
  const service = new FakeLlm([
    { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash" },
    { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek Pro" },
  ]);
  const { adapter, runner } = await runAdapter({ service });
  adapter.setModel("deepseek-v4-pro");
  await Promise.resolve(); // select 是异步提交；等待微任务
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((runner as FakeRunner).currentModel, "deepseek-v4-pro");
});

test("adapter setModel: unknown model reports onError invalid_model", async () => {
  const { adapter, errors } = await runAdapter();
  adapter.setModel("bogus");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "invalid_model");
});

// ---- 命令系统 ----

test("adapter listCommands: returns CommandDescriptor[] with argument_hint", async () => {
  const { adapter } = await runAdapter();
  const commands = await adapter.listCommands();
  const model = commands.find((c) => c.name === "model");
  assert.ok(model, "builtin registry exposes /model");
  assert.equal(model!.argument_hint, "[provider/model | 名称 | --refresh]");
});

test("adapter runCommand: /help writes lines and returns exit false", async () => {
  const { adapter } = await runAdapter();
  const result = await adapter.runCommand("help");
  assert.equal(result.exit, false);
  assert.ok(result.lines.length > 0, "/help 输出帮助行");
});

test("adapter runCommand: /exit returns exit true", async () => {
  const { adapter } = await runAdapter();
  const result = await adapter.runCommand("exit");
  assert.equal(result.exit, true);
  assert.equal(result.lines.length, 0);
});

test("adapter runCommand: /model lists the catalog and carries the model snapshot", async () => {
  const service = new FakeLlm([
    { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash" },
    { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek Pro" },
  ]);
  const { adapter, runner } = await runAdapter({ service });
  const result = await adapter.runCommand("model");
  assert.equal(result.exit, false);
  assert.equal(result.model, "deepseek-flash");
  assert.deepEqual(result.models, [
    { id: "deepseek/deepseek-flash", name: "DeepSeek Flash" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek Pro" },
  ]);
});

test("adapter runCommand: turn-type command throws CommandError turn_not_supported with turnMessage", async () => {
  const skills = [skill("backend-tests", "跑后端测试", "npm test")];
  const { adapter } = await runAdapter({ skills });
  await assert.rejects(
    () => adapter.runCommand("skill", "backend-tests 补测试"),
    (err: unknown) => {
      assert.ok(err instanceof CommandError, `期望 CommandError，实际 ${err}`);
      assert.equal((err as CommandError).code, "turn_not_supported");
      assert.match((err as CommandError).turnMessage ?? "", /【Skill：backend-tests】/);
      return true;
    },
  );
});

test("adapter runCommand: unknown command throws CommandError unknown_command", async () => {
  const { adapter } = await runAdapter();
  await assert.rejects(
    () => adapter.runCommand("bogus"),
    (err: unknown) => {
      assert.ok(err instanceof CommandError);
      assert.equal((err as CommandError).code, "unknown_command");
      return true;
    },
  );
});

// ---- teardown ----

test("adapter stop: idempotent and unblocks the in-flight turn", async () => {
  const { adapter, results } = await runAdapter({ runner: new BlockingRunner() });
  const pending = adapter.prompt("hi");
  await adapter.stop();
  await adapter.stop(); // 幂等
  const result = await pending;
  assert.equal(result.stop_reason, "cancelled", "stop() 中止在途回合，合成 cancelled");
  assert.equal(results.length, 1);
});

// =====================================================================
// real-host suite（mirror test/cli/real-host-rpc.test.ts：同一场景同一线行为）
// =====================================================================

/** One canned model step: an assistant text and/or tool calls. */
interface ScriptedStep {
  text: string;
  toolCalls?: readonly { id: string; name: string; arguments: string }[];
}

/** Scripted ChatModel yielding exactly one `completed` per call; repeats the last step. */
class ScriptedModel implements ChatModel {
  readonly requests: ModelRequest[] = [];
  private readonly steps: readonly ScriptedStep[];
  private index = 0;

  constructor(steps: readonly ScriptedStep[]) {
    if (steps.length === 0) throw new Error("ScriptedModel: at least one step required");
    this.steps = steps;
  }

  get callCount(): number {
    return this.index;
  }

  stream(request: ModelRequest, _signal?: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const step = this.steps[Math.min(this.index, this.steps.length - 1)]!;
    this.index += 1;
    const content: ContentBlock[] = [{ type: "text", text: step.text }];
    for (const call of step.toolCalls ?? []) {
      content.push({ type: "tool-call", id: call.id, name: call.name, arguments: call.arguments });
    }
    const response: ModelResponse = {
      message: { role: "assistant", content },
      finishReason: (step.toolCalls?.length ?? 0) > 0 ? { type: "tool-calls" } : { type: "stop" },
      usage: { inputTokens: 10, outputTokens: 5 },
      model: "fake",
      timestamp: Date.now(),
    };
    return (async function* (): AsyncGenerator<ModelEvent> {
      if (step.text.length > 0) yield { type: "textDelta", delta: step.text };
      yield { type: "completed", response };
    })();
  }
}

/** A signal-aware ChatModel that blocks until the turn's AbortSignal fires, then throws AbortError. */
class BlockingModel implements ChatModel {
  stream(_request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    return (async function* (): AsyncGenerator<ModelEvent> {
      await new Promise<void>((_resolve, reject) => {
        if (signal === undefined) return; // never resolves; not expected in tests
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      throw new Error("unreachable: must be interrupted via abort");
    })();
  }
}

/** Advisory catalog ModelService: refresh is in-memory, auth always "ok" (no network). */
class CatalogService implements ModelService {
  listProviders(): readonly ProviderInfo[] {
    return [{ id: "deepseek", name: "DeepSeek" }];
  }

  listModels(): readonly ModelInfo[] {
    return [
      { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash" },
      { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ];
  }

  async refreshModels(): Promise<readonly ModelInfo[]> {
    return this.listModels();
  }

  async checkAuth(): Promise<boolean> {
    return true;
  }

  async resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    return { provider, id, name: id };
  }
}

interface RealHostOptions {
  diHome: string;
  workspace: string;
  model: ChatModel;
  skills?: readonly Skill[];
}

/** Build the REAL composition-root host with every integration point injected. */
async function buildRealHost(opts: RealHostOptions): Promise<CliHost> {
  return createCliHost(
    makeArgs({}),
    opts.workspace,
    new StringTextWriter(),
    true,
    {
      diHome: DiHome.fromDirectory(opts.diHome),
      modelFactory: () => opts.model,
      modelService: new CatalogService(),
      tools: createFileTools(opts.workspace),
      skills: opts.skills ?? [],
    },
  );
}

/** Drive the adapter against a real host: connect → prompt → stop, capturing the wire. */
async function runRealAdapter(
  opts: RealHostOptions,
): Promise<{ host: CliHost; adapter: LocalAgentRunnerAdapter } & ReturnType<typeof capture>> {
  const host = await buildRealHost(opts);
  const adapter = new LocalAgentRunnerAdapter(host);
  const captured = capture(adapter);
  await adapter.connect();
  return { host, adapter, ...captured };
}

test("real-host adapter: ready handshake carries version/model/skills and the injected catalog models", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-adapt-ready-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-adapt-ready-ws-"));
  try {
    const { host, ready } = await runRealAdapter({ diHome, workspace, model: new ScriptedModel([{ text: "ok" }]) });
    try {
      assert.equal(ready.length, 1);
      const readyDoc = ready[0]!;
      assert.equal(readyDoc.type, "ready");
      assert.equal(readyDoc.version, "0.1.0");
      assert.equal(readyDoc.model, "deepseek-flash");
      assert.ok(!("effort" in readyDoc), "默认无推理强度 → ready 无 effort 键");
      assert.deepEqual(readyDoc.skills, []);
      assert.equal(readyDoc.models?.length, 2);
      assert.equal(readyDoc.models?.[0]?.id, "deepseek/deepseek-flash");
      assert.equal(readyDoc.models?.[0]?.name, "DeepSeek Flash");
      // 与 real-host RPC ready 线字节级等价（real-host-rpc.test.ts）。
      assert.equal(
        JSON.stringify(readyDoc),
        '{"type":"ready","version":"0.1.0","model":"deepseek-flash","skills":[],"models":[{"id":"deepseek/deepseek-flash","name":"DeepSeek Flash"},{"id":"deepseek/deepseek-v4-pro","name":"DeepSeek V4 Pro"}]}',
      );
    } finally {
      host.dispose?.();
    }
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("real-host adapter: prompt emits the exact ready → text_delta → turn_completed → result wire", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-adapt-prompt-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-adapt-prompt-ws-"));
  try {
    const model = new ScriptedModel([{ text: "回答: hi" }]);
    const { host, adapter, events, results } = await runRealAdapter({ diHome, workspace, model });
    try {
      const result = await adapter.prompt("hi");
      await adapter.stop();
      assert.equal(model.callCount, 1, "scripted model answers on the first call");
      // 与 real-host RPC 整线字节级等价（real-host-rpc.test.ts expected）。
      assert.equal(JSON.stringify(events[0]), '{"kind":"text_delta","delta":"回答: hi"}');
      assert.equal(JSON.stringify(events[1]), '{"kind":"turn_completed","iteration":1,"usage":{"input_tokens":10,"output_tokens":5},"finish_reason":"stop"}');
      assert.equal(results.length, 1);
      assert.equal(JSON.stringify(results[0]), '{"answer":"回答: hi","stop_reason":"answer","iterations":1,"usage":{"input_tokens":10,"output_tokens":5}}');
      assert.equal(JSON.stringify(result), JSON.stringify(results[0]));
    } finally {
      host.dispose?.();
    }
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("real-host adapter: a read_file tool call emits tool_started/tool_completed with the real observation", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-adapt-tool-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-adapt-tool-ws-"));
  try {
    writeFileSync(join(workspace, "notes.txt"), "line one\nline two\n");
    const model = new ScriptedModel([
      { text: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"notes.txt"}' }] },
      { text: "done reading" },
    ]);
    const { host, adapter, events, results } = await runRealAdapter({ diHome, workspace, model });
    try {
      const result = await adapter.prompt("hi");
      await adapter.stop();

      assert.equal(model.callCount, 2, "one tool round + one answer call");
      assert.deepEqual(
        events.map((e) => e.kind),
        ["turn_completed", "tool_started", "tool_completed", "text_delta", "turn_completed"],
        "真实 loop 的工具回合线序：iteration1 完成 → started → completed → text_delta → iteration2 完成",
      );

      const started = events[1]!;
      assert.equal(started.kind, "tool_started");
      assert.equal(started.call.id, "c1");
      assert.equal(started.call.name, "read_file");
      assert.equal(started.call.arguments, '{"path":"notes.txt"}');

      const completed = events[2]!;
      assert.equal(completed.kind, "tool_completed");
      assert.equal(completed.call.name, "read_file");
      assert.equal(completed.is_error, false);
      assert.ok(completed.observation.includes("line one"), "observation 是真实 createFileTools 在临时工作区上读出的内容");

      assert.equal((events[0]! as { iteration: number }).iteration, 1);
      assert.equal((events[4]! as { iteration: number }).iteration, 2);

      assert.equal(result.answer, "done reading");
      assert.equal(result.stop_reason, "answer");
      assert.equal(result.iterations, 2);
      assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 10 });
      assert.equal(results.length, 1);
    } finally {
      host.dispose?.();
    }
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("real-host adapter: interrupt aborts a signal-aware model → result.stop_reason cancelled", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-adapt-intr-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-adapt-intr-ws-"));
  try {
    const { host, adapter, events, results } = await runRealAdapter({ diHome, workspace, model: new BlockingModel() });
    try {
      const pending = adapter.prompt("hi");
      adapter.interrupt();
      const result = await pending;
      await adapter.stop();

      assert.equal(events.length, 0, "blocking model 不发事件");
      assert.equal(results.length, 1);
      assert.equal(results[0]!.stop_reason, "cancelled");
      assert.equal(result.stop_reason, "cancelled");
      assert.equal(result.answer, "");
      assert.equal(result.iterations, 0);
      assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
    } finally {
      host.dispose?.();
    }
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("real-host adapter: stop after a turn and the real SessionStore writes the session JSONL", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-adapt-sess-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-adapt-sess-ws-"));
  try {
    const { host, adapter } = await runRealAdapter({ diHome, workspace, model: new ScriptedModel([{ text: "回答: hi" }]) });
    try {
      assert.ok(host.sessionStore !== undefined, "真实 host 拥有 SessionStore（未 --no-session）");
      const sessionFile = host.sessionStore.logFilePath;

      await adapter.prompt("hi");
      await adapter.stop();

      assert.ok(existsSync(sessionFile), "会话 JSONL 文件已创建");
      const records = readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.trim().length > 0);
      assert.ok(records.length >= 1, "会话文件有记录");
      assert.equal(JSON.parse(records[0]!).type, "session_meta", "首行 session_meta");
      const last = JSON.parse(records[records.length - 1]!);
      assert.equal(last.type, "event_msg");
      assert.equal(last.payload.type, "task_complete", "回合审计尾部 task_complete");
      assert.equal(last.payload.stop_reason, "answer");
    } finally {
      host.dispose?.();
    }
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
