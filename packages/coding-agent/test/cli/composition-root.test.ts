import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ChatModel, ContentBlock, ModelEvent, ModelRequest, ModelResponse } from "@di/ai";
import { textOfMessage } from "@di/ai";
import {
  CliApp,
  DiHome,
  ProcessDiagnostics,
  SessionDataError,
  SessionStore,
  StringTextWriter,
  createCliHost,
  DiConfig,
  createFileTools,
  nullTextReader,
  type CliArgs,
  type CliHost,
  type ModelInfo,
  type ModelService,
  type ProviderInfo,
  type ResolvedModelInfo,
  type Skill,
} from "@di/coding-agent";
import { makeArgs } from "../modes/test-host.ts";

/**
 * P7a card — the real composition root (C# `Di.Cli/CliHost.Create` at baseline
 * 09f4e08): replace the fail-closed `defaultCliHostFactory` stub with a host that
 * composes AgentSession + tools (P4.x) + skills (P6.2) + sessionStore (P5) +
 * DiLog (P6.4) + createSessionRunner, wires `--resume` via loadRecovery →
 * restoreHistory, injects ProcessDiagnostics.log into DiLog.log, and resolves the
 * current-model LABEL to the session's ChatModel.
 *
 * The P6.4 emission seams are closed HERE, host-side, without touching
 * packages/agent/: `runStarted` is published by the composition root before each
 * `session.runTurn`; `modelCallStarted` is published by a host-side model wrapper
 * on each model call — so `run: started` and `llm: call_started` /
 * `llm: call_completed duration_ms=…` log lines work end to end.
 *
 * No real network / no real credentials: a scripted ChatModel and an advisory
 * catalog ModelService (checkAuth true, refreshModels from memory) are injected.
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
      // Stream the assistant text as a delta so the mode renderers see it
      // (C#/the FakeRunner publish TextDelta; a completed-only stream would not
      // render the answer in print mode's streaming UI).
      if (step.text.length > 0) yield { type: "textDelta", delta: step.text };
      yield { type: "completed", response };
    })();
  }
}

/** Advisory catalog ModelService: refresh is in-memory, auth always "ok" (no network). */
class CatalogService implements ModelService {
  private readonly contextWindow: number | undefined;
  constructor(contextWindow?: number) { this.contextWindow = contextWindow; }
  listProviders(): readonly ProviderInfo[] {
    return [{ id: "deepseek", name: "DeepSeek" }];
  }

  listModels(): readonly ModelInfo[] {
    return [
      { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash", ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}) },
      { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}) },
    ];
  }

  async refreshModels(): Promise<readonly ModelInfo[]> {
    return this.listModels();
  }

  async checkAuth(): Promise<boolean> {
    return true;
  }

  async resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    return { provider, id, name: id, ...(this.contextWindow !== undefined ? { contextWindow: this.contextWindow } : {}) };
  }
}

interface BuildHostOptions {
  diHome: string;
  workspace: string;
  model?: ChatModel;
  modelFactory?: (label: string) => ChatModel;
  args?: Partial<CliArgs>;
  skills?: readonly Skill[];
  config?: DiConfig;
  contextWindow?: number;
  modelService?: ModelService;
}

async function buildHost(opts: BuildHostOptions): Promise<CliHost> {
  const model = opts.model ?? new ScriptedModel([{ text: "ok" }]);
  const host = await createCliHost(
    makeArgs(opts.args ?? {}),
    opts.workspace,
    new StringTextWriter(),
    true,
    {
      diHome: DiHome.fromDirectory(opts.diHome),
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      modelFactory: opts.modelFactory ?? (() => model),
      modelService: opts.modelService ?? new CatalogService(opts.contextWindow),
      tools: createFileTools(opts.workspace),
      skills: opts.skills ?? [],
    },
  );
  return host;
}

/** Read today's run-log text (the composition root writes di-YYYY-MM-DD.log under DI_HOME/logs). */
function readLog(diHome: string): string {
  const logsDir = join(diHome, "logs");
  const files = readdirSync(logsDir).filter((f) => /^di-\d{4}-\d{2}-\d{2}\.log$/.test(f));
  assert.ok(files.length >= 1, "a di-YYYY-MM-DD.log must exist");
  return readFileSync(join(logsDir, files[0]!), "utf8");
}

test("composition root: builds a real AgentSession-backed host with tools, session store and run logging", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-"));
  try {
    const host = await buildHost({ diHome, workspace });
    assert.ok(host.runner, "session-turn runner seam is present");
    assert.ok(host.models, "model selection is present");
    assert.ok(host.bus, "event bus is present");
    assert.ok(host.commands, "slash-command registry is present");
    assert.ok(host.sessionStore !== undefined, "session store is created (no --no-session)");

    const result = await host.runner.runTurn("hello");
    assert.equal(result.answer, "ok");

    assert.ok(existsSync(host.sessionStore!.logFilePath), "session JSONL is written");
    const log = readLog(diHome);
    assert.ok(log.includes("di starting pid="), "host startup line is logged");
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composition root: runStarted + modelCallStarted emitted around each turn; DiLog writes run/llm lines", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-"));
  try {
    const model = new ScriptedModel([{ text: "hello world" }]);
    const host = await buildHost({ diHome, workspace, model });
    const seen: string[] = [];
    host.bus.subscribeWith((e) => seen.push(e.type));

    const result = await host.runner.runTurn("hi there");
    assert.equal(result.answer, "hello world");
    assert.ok(seen.includes("runStarted"), "runStarted must be published for the turn");
    assert.ok(seen.includes("modelCallStarted"), "modelCallStarted must be published on the model call");

    const log = readLog(diHome);
    assert.ok(log.includes("run: started user_input=hi there"), "run: started log line");
    assert.ok(log.includes("llm: call_started iteration=1"), "llm: call_started log line");
    // The P6.4 DiLog format appends duration_ms at the END of the completed line
    // (after finish=), so assert both markers on the same line.
    assert.ok(
      log.includes("llm: call_completed iteration=1") && log.includes("duration_ms="),
      "llm: call_completed log line carries duration_ms",
    );
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composition root: runStarted carries the user message in order, once per turn", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-"));
  try {
    const host = await buildHost({ diHome, workspace });
    const all: string[] = [];
    const runStarted: string[] = [];
    host.bus.subscribeWith((e) => {
      all.push(e.type);
      if (e.type === "runStarted") runStarted.push(e.userMessage);
    });

    await host.runner.runTurn("first");
    await host.runner.runTurn("second");
    assert.deepEqual(runStarted, ["first", "second"], "one runStarted per turn, in order");
    assert.equal(all[0], "runStarted", "the first published event of the first turn is runStarted");
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composition root: dispose writes di exiting and clears the ProcessDiagnostics hook", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-"));
  try {
    const host = await buildHost({ diHome, workspace });
    assert.ok(ProcessDiagnostics.log !== null, "host wires ProcessDiagnostics → DiLog");
    host.dispose?.();
    assert.equal(ProcessDiagnostics.log, null, "dispose resets the static hook");
    const log = readLog(diHome);
    assert.ok(log.includes("di exiting"), "exit line is logged");
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composition root: --no-session creates no session store", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-"));
  try {
    const host = await buildHost({ diHome, workspace, args: { noSession: true } });
    assert.equal(host.sessionStore, undefined, "no session store when --no-session");
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composition root: --resume restores the checkpointed trajectory into the session", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-"));
  try {
    const store = new SessionStore({ rootDirectory: diHome });
    store.startSession();
    store.beginCheckpointTurn("first", Date.now(), []);
    store.appendCheckpointMessage({ role: "user", content: [{ type: "text", text: "first" }] });
    store.appendCheckpointMessage({ role: "assistant", content: [{ type: "text", text: "earlier answer" }] });
    store.completeCheckpointTurn({ stopReason: "answer", iterations: 1 });

    const model = new ScriptedModel([{ text: "resumed answer" }]);
    const host = await buildHost({ diHome, workspace, model, args: { resume: store.logFilePath } });
    await host.runner.runTurn("continue");
    const firstRequest = model.requests[0]!;
    assert.ok(
      firstRequest.messages.some((m) => m.role === "assistant" && textOfMessage(m) === "earlier answer"),
      "the restored assistant message appears in the next turn's model request",
    );
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composition root: --resume with an unknown-outcome log rejects the host (fail closed)", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-"));
  try {
    const store = new SessionStore({ rootDirectory: diHome });
    store.startSession();
    store.beginCheckpointTurn("run", Date.now(), []);
    store.appendCheckpointMessage({
      role: "assistant",
      content: [{ type: "text", text: "x" }, { type: "tool-call", id: "c1", name: "t", arguments: "{}" }],
    });
    store.checkpointToolStarted({ type: "tool-call", id: "c1", name: "t", arguments: "{}" });

    await assert.rejects(
      createCliHost(makeArgs({ resume: store.logFilePath }), workspace, new StringTextWriter(), true, {
        diHome: DiHome.fromDirectory(diHome),
        modelFactory: () => new ScriptedModel([{ text: "x" }]),
        modelService: new CatalogService(),
        tools: createFileTools(workspace),
      }),
      (error) => error instanceof SessionDataError && error.code === "unknown-outcome",
      "--resume on an unknown-outcome log must fail closed",
    );
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composition root: setCurrentModel resolves the label to the session's ChatModel", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-"));
  try {
    const labels: string[] = [];
    const factory = (label: string): ChatModel => {
      labels.push(label);
      return new ScriptedModel([{ text: "m" }]);
    };
    const host = await buildHost({ diHome, workspace, modelFactory: factory, args: { model: "deepseek-flash" } });
    host.runner.setCurrentModel("deepseek-v4-pro");
    await host.runner.runTurn("hi");
    assert.ok(labels.includes("deepseek-v4-pro"), "the new model label is resolved to a ChatModel");
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composition root: known context window pauses before an over-budget model request and preserves the trajectory", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-budget-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-budget-"));
  try {
    const model = new ScriptedModel([{ text: "must not be requested" }]);
    const config = DiConfig.merge({}, undefined, {
      ContextManagement: { Enabled: true, MarginRatio: 0, OutputReserveTokens: 0 },
    }, {});
    const host = await buildHost({ diHome, workspace, model, contextWindow: 20, config });
    const result = await host.runner.runTurn("a request larger than the tiny test window");
    assert.equal(result.stopReason, "context_limit");
    assert.equal(model.callCount, 0, "guard runs before any model call");
    assert.equal(result.trajectory.at(-1)?.role, "user", "the paused request remains available for resume/review");
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composition root: disabling context management keeps the known-window history-ratio guard", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-disabled-budget-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-disabled-budget-"));
  try {
    const model = new ScriptedModel([{ text: "must not be requested" }]);
    const config = DiConfig.merge({}, undefined, {
      ContextManagement: { Enabled: false },
      AgentLoop: { HistoryBudgetRatio: 0.1 },
    }, {});
    const host = await buildHost({ diHome, workspace, model, contextWindow: 20, config });
    const result = await host.runner.runTurn("a request larger than the tiny test window");
    assert.equal(result.stopReason, "context_limit");
    assert.equal(model.callCount, 0);
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composition root: invalid negative iteration config is rejected instead of silently becoming unlimited", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-invalid-budget-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-invalid-budget-"));
  try {
    const config = DiConfig.merge({}, undefined, { AgentLoop: { MaxIterations: -1 } }, {});
    await assert.rejects(buildHost({ diHome, workspace, config }), /agentloop:maxiterations must be a non-negative integer/);
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composition root: unknown windows stay unbounded and turn configuration reaches the model request", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-options-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-options-"));
  try {
    const model = new ScriptedModel([{ text: "answer" }]);
    const config = DiConfig.merge({}, undefined, {
      AgentLoop: { MaxIterations: 1, MaxTokens: 77, ReasoningEffort: "high" },
    }, {});
    const host = await buildHost({ diHome, workspace, model, config });
    const result = await host.runner.runTurn("hello");
    assert.equal(result.answer, "answer");
    assert.equal(model.callCount, 1, "unknown context windows do not fabricate a token cap");
    assert.equal(model.requests[0]?.maxTokens, 77);
    assert.equal(model.requests[0]?.reasoningEffort, "high");
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composition root: model switch recalculates policy; unknown target removes the old limit", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-switch-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-switch-"));
  try {
    const model = new ScriptedModel([{ text: "answer" }]);
    const service: ModelService = {
      listProviders: () => [{ id: "deepseek", name: "DeepSeek" }],
      listModels: () => [
        { provider: "deepseek", id: "deepseek-flash", name: "tiny", contextWindow: 20 },
        { provider: "deepseek", id: "deepseek-v4-pro", name: "unknown" },
      ],
      refreshModels: async () => [],
      checkAuth: async () => true,
      resolveModel: async (provider, id) => ({ provider, id, name: id }),
    };
    const config = DiConfig.merge({}, undefined, { ContextManagement: { Enabled: true, MarginRatio: 0, OutputReserveTokens: 0 } }, {});
    const host = await buildHost({ diHome, workspace, model, config, modelService: service });
    const paused = await host.runner.runTurn("a prompt beyond the tiny window");
    assert.equal(paused.stopReason, "context_limit");
    host.runner.resetHistory();
    host.runner.setCurrentModel("deepseek-v4-pro");
    const resumed = await host.runner.runTurn("hello");
    assert.equal(resumed.answer, "answer");
    assert.equal(model.callCount, 1, "the unknown target has no inherited limit");
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composition root: print mode through CliApp drives the real host end to end", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-"));
  try {
    const stdout = new StringTextWriter();
    const stderr = new StringTextWriter();
    const app = new CliApp(
      (args, ws, err, ansi) =>
        createCliHost(args, ws, err, ansi, {
          diHome: DiHome.fromDirectory(diHome),
          modelFactory: () => new ScriptedModel([{ text: "printed answer" }]),
          modelService: new CatalogService(),
          tools: createFileTools(workspace),
          skills: [],
        }),
    );
    const exit = await app.runAsync(["--print", "hello"], nullTextReader, stdout, stderr, false, false);
    assert.equal(exit, 0, "print mode exits 0 through the real host");
    assert.ok(stdout.text().includes("printed answer"), "print mode renders the model answer");
    const log = readLog(diHome);
    assert.ok(log.includes("di starting pid="), "the run log is written through the real host");
    assert.ok(log.includes("di exiting"), "the dispose chain runs after the mode body");
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composition root: tools are wired through the real executor (read_file round trip)", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-compose-"));
  const workspace = mkdtempSync(join(tmpdir(), "di-ws-"));
  try {
    writeFileSync(join(workspace, "notes.txt"), "line one\nline two\n");
    const model = new ScriptedModel([
      { text: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"notes.txt"}' }] },
      { text: "done reading" },
    ]);
    const host = await buildHost({ diHome, workspace, model });
    const result = await host.runner.runTurn("read it");
    assert.equal(result.answer, "done reading");
    const toolResult = result.trajectory.find((m) => m.role === "tool");
    assert.ok(toolResult !== undefined, "the tool observation lands in the trajectory");
    assert.ok(textOfMessage(toolResult).includes("line one"), "the read_file output is the observation");
  } finally {
    rmSync(diHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
