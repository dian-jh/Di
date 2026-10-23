import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatModel, ContentBlock, ModelEvent, ModelRequest, ModelResponse } from "@di/ai";
import {
  DiHome,
  LineTextReader,
  StringTextWriter,
  createCliHost,
  createFileTools,
  runRpcMode,
  type CliArgs,
  type CliHost,
  type ModelInfo,
  type ModelService,
  type ProviderInfo,
  type ResolvedModelInfo,
  type Skill,
} from "@di/coding-agent";
import { inputLines, makeArgs, outputLines } from "../modes/test-host.ts";

/**
 *
 * backend (`createCliHost`: AgentSession + real tools + real SessionStore + DiLog
 * + ModelSelection), mirroring the fake-Runner protocol suite
 * (test/modes/rpc-mode.test.ts). "Same RPC scenarios, same observed behavior on
 * both backends": ready handshake, prompt event stream + result, a real read_file
 * tool call (tool_started/tool_completed with a genuine observation), busy
 * rejection mid-turn, interrupt → result.stop_reason "cancelled", and shutdown →
 * exit 0 with the session JSONL written by the real SessionStore.
 *
 * All injection is hermetic: isolated temp DI_HOME + temp workspace, scripted
 * ChatModel, in-memory advisory catalog (checkAuth true, refresh from memory).
 * No network, no real credentials, no real skills (skills injected as [] so the
 * host never discovers anything from the environment).
 */

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

/**
 * A signal-aware ChatModel that blocks inside `stream` until the turn's
 * AbortSignal fires, then throws an AbortError (mirrors the fake suite's
 * `BlockingRunner`): validates interrupt → result.stop_reason "cancelled" and the
 * busy envelope through the real host.
 */
class BlockingModel implements ChatModel {
  stream(_request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    return (async function* (): AsyncGenerator<ModelEvent> {
      await new Promise<void>((_resolve, reject) => {
        if (signal === undefined) {
          return; // never resolves; not expected in tests
        }
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
  args?: Partial<CliArgs>;
  skills?: readonly Skill[];
}

/** Build the REAL composition-root host with every integration point injected. */
async function buildRealHost(opts: RealHostOptions): Promise<CliHost> {
  return createCliHost(
    makeArgs(opts.args ?? {}),
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

/** Drive `runRpcMode` in-process over the given host (same driver the fake suite uses). */
async function runRpc(host: CliHost, input: string, args: Partial<CliArgs> = {}) {
  const stdout = new StringTextWriter();
  const stderr = new StringTextWriter();
  const code = await runRpcMode(host, makeArgs(args), new LineTextReader(inputLines(input)), stdout, stderr);
  return { code, stdout, stderr };
}

const PROMPT_SHUTDOWN = `
{"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
{"type":"request","id":2,"method":"shutdown","params":{}}
`;

// ---- 握手与退出 ----

test("real-host RPC: ready handshake carries version/model/skills and the injected catalog models", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-real-rpc-ready-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-real-rpc-ready-ws-"));
  try {
    const host = await buildRealHost({ diHome, workspace, model: new ScriptedModel([{ text: "ok" }]) });
    try {
      const { code, stdout, stderr } = await runRpc(host, '{"type":"request","id":1,"method":"shutdown","params":{}}');

      assert.equal(code, 0);
      const doc = JSON.parse(outputLines(stdout.text())[0]!);
      assert.equal(doc.type, "ready");
      assert.equal(doc.version, "0.1.0");
      assert.equal(doc.model, "deepseek-flash");
      assert.ok(!("effort" in doc), "默认无推理强度 → ready 无 effort 键");
      assert.deepEqual(doc.skills, []);
      assert.equal(doc.models.length, 2);
      assert.equal(doc.models[0].id, "deepseek/deepseek-flash", "models 来自注入的 catalog，带 provider 路由");
      assert.equal(doc.models[0].name, "DeepSeek Flash");
      assert.equal(doc.models[1].id, "deepseek/deepseek-v4-pro");
      assert.equal(stderr.text(), "");
    } finally {
      host.dispose?.();
    }
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- prompt：事件流 + result（与 fake 套件同形） ----

test("real-host RPC: prompt emits the exact ready → text_delta → turn_completed → result wire", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-real-rpc-prompt-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-real-rpc-prompt-ws-"));
  try {
    const model = new ScriptedModel([{ text: "回答: hi" }]);
    const host = await buildRealHost({ diHome, workspace, model });
    try {
      const { code, stdout, stderr } = await runRpc(host, PROMPT_SHUTDOWN);

      assert.equal(code, 0);
      assert.equal(model.callCount, 1, "scripted model answers on the first call");
      const expected =
        '{"type":"ready","version":"0.1.0","model":"deepseek-flash","skills":[],"models":[{"id":"deepseek/deepseek-flash","name":"DeepSeek Flash"},{"id":"deepseek/deepseek-v4-pro","name":"DeepSeek V4 Pro"}]}\n' +
        '{"type":"event","seq":1,"event":{"kind":"text_delta","delta":"回答: hi"}}\n' +
        '{"type":"event","seq":2,"event":{"kind":"turn_completed","iteration":1,"usage":{"input_tokens":10,"output_tokens":5},"finish_reason":"stop"}}\n' +
        '{"type":"result","seq":3,"result":{"answer":"回答: hi","stop_reason":"answer","iterations":1,"usage":{"input_tokens":10,"output_tokens":5}}}\n';
      assert.equal(stdout.text(), expected);
      assert.equal(stderr.text(), "");
    } finally {
      host.dispose?.();
    }
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- prompt 触发真实工具调用 ----

test("real-host RPC: a read_file tool call emits tool_started/tool_completed with the real observation", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-real-rpc-tool-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-real-rpc-tool-ws-"));
  try {
    writeFileSync(join(workspace, "notes.txt"), "line one\nline two\n");
    const model = new ScriptedModel([
      { text: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"notes.txt"}' }] },
      { text: "done reading" },
    ]);
    const host = await buildRealHost({ diHome, workspace, model });
    try {
      const { code, stdout } = await runRpc(host, PROMPT_SHUTDOWN);

      assert.equal(code, 0);
      assert.equal(model.callCount, 2, "one tool round + one answer call");
      const lines = outputLines(stdout.text()).map((line) => JSON.parse(line));

      const events = lines.filter((d) => d.type === "event");
      assert.deepEqual(
        events.map((d) => d.event.kind),
        ["turn_completed", "tool_started", "tool_completed", "text_delta", "turn_completed"],
        "真实 loop 的工具回合线序：iteration1 完成 → started → completed → text_delta → iteration2 完成",
      );
      assert.deepEqual(
        events.map((d) => d.seq),
        [1, 2, 3, 4, 5],
        "seq 回合内自 1 单调递增",
      );

      const started = events[1]!;
      assert.equal(started.event.kind, "tool_started");
      assert.equal(started.event.call.id, "c1");
      assert.equal(started.event.call.name, "read_file");
      assert.equal(started.event.call.arguments, '{"path":"notes.txt"}');

      const completed = events[2]!;
      assert.equal(completed.event.kind, "tool_completed");
      assert.equal(completed.event.call.name, "read_file");
      assert.equal(completed.event.is_error, false);
      assert.ok(completed.event.observation.includes("line one"), "observation 是真实 createFileTools 在临时工作区上读出的内容");

      const tc1 = events[0]!;
      assert.equal(tc1.event.iteration, 1);
      assert.equal(tc1.event.finish_reason, "tool-calls");
      assert.deepEqual(tc1.event.usage, { input_tokens: 10, output_tokens: 5 });

      const tc2 = events[4]!;
      assert.equal(tc2.event.iteration, 2);
      assert.equal(tc2.event.finish_reason, "stop");
      assert.deepEqual(tc2.event.usage, { input_tokens: 20, output_tokens: 10 });

      const result = lines[lines.length - 1]!;
      assert.equal(result.type, "result");
      assert.equal(result.result.answer, "done reading");
      assert.equal(result.result.stop_reason, "answer");
      assert.equal(result.result.iterations, 2);
      assert.deepEqual(result.result.usage, { input_tokens: 20, output_tokens: 10 });
    } finally {
      host.dispose?.();
    }
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- busy envelope：回合进行中拒绝模型切换 ----

test("real-host RPC: set_model during a running turn emits error:busy, then interrupt yields cancelled", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-real-rpc-busy-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-real-rpc-busy-ws-"));
  try {
    const host = await buildRealHost({ diHome, workspace, model: new BlockingModel() });
    try {
      const { code, stdout } = await runRpc(
        host,
        `
{"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
{"type":"request","id":2,"method":"set_model","params":{"model":"deepseek/deepseek-v4-pro"}}
{"type":"request","id":3,"method":"interrupt","params":{}}
`,
      );

      assert.equal(code, 0);
      const lines = outputLines(stdout.text());
      const err = JSON.parse(lines[1]!);
      assert.equal(err.type, "error");
      assert.equal(err.code, "busy");
      assert.ok(err.message.includes("等待当前回合结束"), "busy 应答解释回合进行中");
      const result = JSON.parse(lines[lines.length - 1]!);
      assert.equal(result.type, "result");
      assert.equal(result.result.stop_reason, "cancelled");
    } finally {
      host.dispose?.();
    }
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- interrupt → cancelled ----

test("real-host RPC: interrupt aborts a signal-aware model → result.stop_reason cancelled", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-real-rpc-intr-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-real-rpc-intr-ws-"));
  try {
    const host = await buildRealHost({ diHome, workspace, model: new BlockingModel() });
    try {
      const { code, stdout } = await runRpc(
        host,
        `
{"type":"request","id":1,"method":"prompt","params":{"message":"hi"}}
{"type":"request","id":2,"method":"interrupt","params":{}}
`,
      );

      assert.equal(code, 0);
      const lines = outputLines(stdout.text());
      assert.equal(lines.length, 2, "blocking model 不发事件：ready + 一条合成 cancelled result");
      const result = JSON.parse(lines[1]!);
      assert.equal(result.type, "result");
      assert.equal(result.seq, 1);
      assert.equal(result.result.stop_reason, "cancelled");
      assert.equal(result.result.answer, "");
      assert.equal(result.result.iterations, 0);
      assert.deepEqual(result.result.usage, { input_tokens: 0, output_tokens: 0 });
    } finally {
      host.dispose?.();
    }
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ---- shutdown → exit 0 + 真实 SessionStore 写会话 JSONL ----

test("real-host RPC: shutdown exits 0 and the real SessionStore writes the session JSONL", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-real-rpc-sess-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-real-rpc-sess-ws-"));
  try {
    const host = await buildRealHost({ diHome, workspace, model: new ScriptedModel([{ text: "回答: hi" }]) });
    try {
      assert.ok(host.sessionStore !== undefined, "真实 host 拥有 SessionStore（未 --no-session）");
      const sessionFile = host.sessionStore.logFilePath;

      const { code, stdout } = await runRpc(host, PROMPT_SHUTDOWN);
      assert.equal(code, 0);

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
