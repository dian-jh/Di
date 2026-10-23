import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatModel, ContentBlock, ModelEvent, ModelRequest, ModelResponse } from "@di/ai";
import {
  DiHome,
  LineTextReader,
  StringTextWriter,
  createCliHost,
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
 * RPC wiring as real-host-rpc.test.ts, but the injected tool set is the bash
 * tool and the scripted model issues a REAL one-shot shell call through the
 * platform shell name. This is the true wiring acceptance: prompt →
 * tool_started → tool_completed (with a genuine "exit: 0" + command output
 * observation) → text_delta → turn_completed, through AgentSession + the real
 * executor + runRpcMode. No mocks, no network, no real credentials.
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

const IS_WINDOWS = process.platform === "win32";
const PLATFORM_SHELL_NAME = IS_WINDOWS ? "cmd" : "bash";
const SET_SESSION_STATE = IS_WINDOWS
  ? "cd /d sub & set DI_SHELL_SESSION=alive"
  : "cd sub && export DI_SHELL_SESSION=alive";
const READ_SESSION_STATE = IS_WINDOWS ? "cd & echo %DI_SHELL_SESSION%" : "pwd; echo $DI_SHELL_SESSION";


async function runRpc(host: CliHost, input: string) {
  const stdout = new StringTextWriter();
  const stderr = new StringTextWriter();
  const code = await runRpcMode(host, makeArgs({}), new LineTextReader(inputLines(input)), stdout, stderr);
  return { code, stdout, stderr };
}

test("real composition root: a bash tool call emits the exact tool round and a real exit: 0 observation", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-bash-rpc-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-bash-rpc-ws-"));
  try {
    const stateCd = IS_WINDOWS ? 'cd /d "..\\state"' : 'cd "../state"';
    const model = new ScriptedModel([
      {
        text: "",
        toolCalls: [
          { id: "c1", name: PLATFORM_SHELL_NAME, arguments: JSON.stringify({ command: SET_SESSION_STATE }) },
          { id: "c2", name: PLATFORM_SHELL_NAME, arguments: JSON.stringify({ command: READ_SESSION_STATE }) },
          { id: "c3", name: PLATFORM_SHELL_NAME, arguments: JSON.stringify({ command: stateCd }) },
          { id: "c4", name: PLATFORM_SHELL_NAME, arguments: JSON.stringify({ command: IS_WINDOWS ? "cd" : "pwd" }) },
        ],
      },
      { text: "done running" },
    ]);
    mkdirSync(join(workspace, "sub"));
    mkdirSync(join(workspace, "state"));
    const host = await createCliHost(
      makeArgs({}),
      workspace,
      new StringTextWriter(),
      true,
      {
        diHome: DiHome.fromDirectory(diHome),
        modelFactory: () => model,
        modelService: new CatalogService(),
        skills: [] as readonly Skill[],
      },
    );
    try {
      const { code, stdout, stderr } = await runRpc(
        host,
        `
{"type":"request","id":1,"method":"prompt","params":{"message":"run it"}}
{"type":"request","id":2,"method":"shutdown","params":{}}
`,
      );

      assert.equal(code, 0);
      assert.equal(model.callCount, 2, "one tool round + one answer call");
      const shellSpec = model.requests[0]!.tools!.find((tool) => tool.name === PLATFORM_SHELL_NAME)!;
      assert.ok(shellSpec.description.includes("持久化"), shellSpec.description);
      assert.equal((shellSpec.parameters.properties as Record<string, unknown>).working_dir, undefined);
      assert.equal(stderr.text(), "");
      const lines = outputLines(stdout.text()).map((line) => JSON.parse(line));

      const events = lines.filter((d) => d.type === "event");
      assert.deepEqual(
        events.map((d) => d.event.kind),
        ["turn_completed", "tool_started", "tool_completed", "tool_started", "tool_completed", "tool_started", "tool_completed", "tool_started", "tool_completed", "text_delta", "turn_completed"],
        "真实 loop 的 bash 工具回合线序：iteration1 完成 → started → completed → text_delta → iteration2 完成",
      );

      const started = events[1]!;
      assert.equal(started.event.kind, "tool_started");
      assert.equal(started.event.call.id, "c1");
      assert.equal(started.event.call.name, PLATFORM_SHELL_NAME);
      assert.equal(started.event.call.arguments, JSON.stringify({ command: SET_SESSION_STATE }));

      const completed = events[2]!;
      assert.equal(completed.event.kind, "tool_completed");
      assert.equal(completed.event.call.name, PLATFORM_SHELL_NAME);
      assert.equal(completed.event.is_error, false);
      assert.ok(completed.event.observation.includes("exit: 0"), completed.event.observation);
      const stateRead = events[4]!;
      assert.equal(stateRead.event.kind, "tool_completed");
      assert.equal(stateRead.event.call.id, "c2");
      assert.ok(stateRead.event.observation.includes("alive"), stateRead.event.observation);
      assert.ok(stateRead.event.observation.includes("sub"), stateRead.event.observation);
      const directoryChanged = events[6]!;
      assert.equal(directoryChanged.event.kind, "tool_completed");
      assert.equal(directoryChanged.event.call.id, "c3");
      assert.equal(directoryChanged.event.is_error, false);
      assert.ok(directoryChanged.event.observation.includes("exit: 0"), directoryChanged.event.observation);
      const directoryRead = events[8]!;
      assert.equal(directoryRead.event.kind, "tool_completed");
      assert.equal(directoryRead.event.call.id, "c4");
      assert.ok(directoryRead.event.observation.includes(join(workspace, "state")), directoryRead.event.observation);

      const result = lines[lines.length - 1]!;
      assert.equal(result.type, "result");
      assert.equal(result.result.answer, "done running");
      assert.equal(result.result.stop_reason, "answer");
      assert.equal(result.result.iterations, 2);
    } finally {
      host.dispose?.();
    }
  } finally {
    await rm(diHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
});
