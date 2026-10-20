import type { AgentResult, AgentEvent, StopReason } from "@di/agent";
import type { LlmFailure, TokenUsage, UsageCost } from "@di/ai";
import {
  EventBus,
  ModelSelection,
  createBuiltinRegistry,
  type CliArgs,
  type CliHost,
  type ModelInfo,
  type ModelSelectionHost,
  type ModelService,
  type ProviderInfo,
  type ReplOptions,
  type ResolvedModelInfo,
  type Skill,
  type SlashCommandRegistry,
  type TurnRunner,
} from "@di/coding-agent";

/**
 * P6.3c mode-test doubles (the C# `Di.Cli.Tests/cli/TestDoubles.cs` counterparts):
 * a fake model service, a fake turn runner that publishes AgentLoopEvent deltas to
 * an in-memory bus (exactly like C# `FakeRunner`), the failure runners
 * (ThrowingRunner / ErrorRunner / BlockingRunner / DeltaRunner / ToolRunner /
 * SoftStopRunner), and a `buildHost` composition mirroring C# `CliHost`.
 */

/** One full skill (C# `new Skill { ... }`). */
export function skill(name: string, description: string, instructions = ""): Skill {
  return { name, description, instructions, metadata: {}, allowedTools: [], disableModelInvocation: false, directory: "" };
}

/** A `CliArgs` with safe defaults (C# `new CliArgs { ... }`). */
export function makeArgs(partial: Partial<CliArgs> = {}): CliArgs {
  return {
    positionals: [],
    model: undefined,
    provider: undefined,
    print: false,
    mode: undefined,
    version: false,
    info: false,
    help: false,
    listModels: null,
    stats: undefined,
    skillEval: undefined,
    thinking: undefined,
    noSession: false,
    resume: undefined,
    noAnsi: false,
    unknownFlags: [],
    ...partial,
  };
}

/** Split an NDJSON input string into lines; `""` is EOF (no lines). */
export function inputLines(input: string): string[] {
  if (input === "") return [];
  // C# raw-string-literal semantics: the newlines framing the content are not content.
  const trimmed = input.replace(/^\n/, "").replace(/\n$/, "");
  return trimmed.replace(/\r\n/g, "\n").split("\n");
}

/** Split an output text into non-trailing lines. */
export function outputLines(output: string): string[] {
  return output.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

/** Base runner implementing the shared host seams (C# `IAgentRunner` subset). */
export class FakeRunnerBase implements TurnRunner, ModelSelectionHost {
  currentModel = "deepseek-flash";
  activeSkills: readonly Skill[] = [];
  busy = false;
  resetCalls = 0;
  reasoningChanges: (string | null)[] = [];

  setCurrentModel(model: string): void {
    this.currentModel = model;
  }

  isBusy(): boolean {
    return this.busy;
  }

  onReasoningChanged(effort: string | null): void {
    this.reasoningChanges.push(effort);
  }

  resetHistory(): void {
    this.resetCalls += 1;
  }

  setActiveSkills(skills: readonly Skill[]): void {
    this.activeSkills = [...skills];
  }

  async runTurn(_userMessage: string, _signal?: AbortSignal): Promise<AgentResult> {
    throw new Error("not implemented");
  }
}

/** Publishes TextDelta + TurnCompleted and returns a configurable result (C# `FakeRunner`). */
export class FakeRunner extends FakeRunnerBase {
  bus?: EventBus;
  emitReasoning = false;
  messages: string[] = [];
  skillSnapshots: Skill[][] = [];
  usage: TokenUsage = { inputTokens: 10, outputTokens: 20 };
  cost: UsageCost | undefined;
  stopReason: StopReason = "answer";
  failure: LlmFailure | undefined;

  override async runTurn(userMessage: string, _signal?: AbortSignal): Promise<AgentResult> {
    this.messages.push(userMessage);
    this.skillSnapshots.push([...this.activeSkills]);
    if (this.bus !== undefined) {
      if (this.emitReasoning) this.bus.publish({ type: "reasoningDelta", delta: "先想想为什么" });
      this.bus.publish({ type: "textDelta", delta: `回答: ${userMessage}` });
      this.bus.publish({
        type: "turnCompleted",
        iteration: 1,
        usage: this.usage,
        finishReason: { type: "stop" },
        ...(this.cost !== undefined ? { cost: this.cost } : {}),
      });
    }
    return {
      answer: `回答: ${userMessage}`,
      trajectory: [{ role: "user", content: [{ type: "text", text: userMessage }] }],
      history: [],
      iterations: 1,
      usage: this.usage,
      ...(this.cost !== undefined ? { cost: this.cost } : {}),
      stopReason: this.stopReason,
      ...(this.failure !== undefined ? { failure: this.failure } : {}),
    };
  }
}

/** `RunAsync` throws directly (simulates credential / transport failure). */
export class ThrowingRunner extends FakeRunnerBase {
  override async runTurn(_userMessage: string, _signal?: AbortSignal): Promise<AgentResult> {
    throw new Error("boom");
  }
}

/** Returns a StopReason.Error result (simulates a non-retryable model error). */
export class ErrorRunner extends FakeRunnerBase {
  bus?: EventBus;
  failure: LlmFailure = { code: "missing_credential", message: "缺少 API Key" };

  override async runTurn(userMessage: string, _signal?: AbortSignal): Promise<AgentResult> {
    if (this.bus !== undefined) {
      this.bus.publish({
        type: "turnCompleted",
        iteration: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: { type: "error", failure: this.failure },
      });
    }
    return {
      answer: "",
      trajectory: [{ role: "user", content: [{ type: "text", text: userMessage }] }],
      history: [],
      iterations: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "error",
      failure: this.failure,
    };
  }
}

/** Publishes reasoning + tool_call deltas (validates delta wire shapes). */
export class DeltaRunner extends FakeRunnerBase {
  bus?: EventBus;

  override async runTurn(userMessage: string, _signal?: AbortSignal): Promise<AgentResult> {
    if (this.bus !== undefined) {
      this.bus.publish({ type: "reasoningDelta", delta: "思考中" });
      this.bus.publish({ type: "toolCallDelta", id: "c1", name: "echo", arguments: '{"x":1}' });
      this.bus.publish({
        type: "turnCompleted",
        iteration: 1,
        usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 },
        finishReason: { type: "stop" },
      });
    }
    return {
      answer: "ok",
      trajectory: [{ role: "user", content: [{ type: "text", text: userMessage }] }],
      history: [],
      iterations: 1,
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 },
      stopReason: "answer",
    };
  }
}

/** Publishes tool lifecycle events (validates tool_started / tool_completed wire shapes). */
export class ToolRunner extends FakeRunnerBase {
  bus?: EventBus;

  override async runTurn(userMessage: string, _signal?: AbortSignal): Promise<AgentResult> {
    if (this.bus !== undefined) {
      this.bus.publish({ type: "toolStarted", call: { type: "tool-call", id: "c1", name: "echo", arguments: "{}" } });
      this.bus.publish({ type: "toolCompleted", call: { type: "tool-call", id: "c1", name: "echo", arguments: "{}" }, observation: "obs", isError: false });
      this.bus.publish({
        type: "turnCompleted",
        iteration: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: { type: "stop" },
      });
    }
    return {
      answer: "ok",
      trajectory: [{ role: "user", content: [{ type: "text", text: userMessage }] }],
      history: [],
      iterations: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "answer",
    };
  }
}

/** Blocks until the signal aborts (validates interrupt → result.stop_reason:cancelled). */
export class BlockingRunner extends FakeRunnerBase {
  override async runTurn(_userMessage: string, signal?: AbortSignal): Promise<AgentResult> {
    await new Promise<void>((_resolve, reject) => {
      if (signal === undefined) return; // never resolves; not expected in tests
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    throw new Error("unreachable: must be interrupted via abort");
  }
}

/** Records skill snapshots and reset calls; returns an empty result (C# `ClearHistoryRunner`). */
export class ClearHistoryRunner extends FakeRunnerBase {
  skillSnapshots: Skill[][] = [];

  override async runTurn(userMessage: string, _signal?: AbortSignal): Promise<AgentResult> {
    this.skillSnapshots.push([...this.activeSkills]);
    return {
      answer: "",
      trajectory: [{ role: "user", content: [{ type: "text", text: userMessage }] }],
      history: [],
      iterations: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "answer",
    };
  }
}

/** Converges with stop_reason "interrupted" (validates the soft-stop wire). */
export class SoftStopRunner extends FakeRunnerBase {
  override async runTurn(userMessage: string, _signal?: AbortSignal): Promise<AgentResult> {
    return {
      answer: "部分输出",
      trajectory: [{ role: "user", content: [{ type: "text", text: userMessage }] }],
      history: [],
      iterations: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "interrupted",
    };
  }
}

/** Fake model service answering the advisory catalog (C# `FakeLlm`). */
export class FakeLlm implements ModelService {
  private readonly models_: readonly ModelInfo[];

  constructor(models: readonly ModelInfo[]) {
    this.models_ = models;
  }

  listProviders(): readonly ProviderInfo[] {
    return [];
  }

  listModels(_provider?: string): readonly ModelInfo[] {
    return this.models_;
  }

  async refreshModels(_provider: string, _signal?: AbortSignal): Promise<readonly ModelInfo[]> {
    return this.models_;
  }

  async checkAuth(_provider: string, _signal?: AbortSignal): Promise<boolean> {
    return true;
  }

  async resolveModel(provider: string, id: string, _signal?: AbortSignal): Promise<ResolvedModelInfo> {
    const model = this.models_.find((m) => m.provider === provider && m.id === id);
    if (model === undefined) throw new Error(`unknown model '${provider}/${id}'`);
    return { provider, id, name: model.name };
  }
}

export interface BuildHostOptions {
  runner?: TurnRunner & ModelSelectionHost;
  service?: ModelService;
  skills?: readonly Skill[];
  bus?: EventBus;
  commands?: SlashCommandRegistry;
  sessionStore?: CliHost["sessionStore"];
  reasoningEffort?: string | null;
  replOptions?: ReplOptions;
}

/**
 * Compose a full `CliHost` mirroring the C# `CliHost` constructor: a ModelSelection
 * over the runner (which implements the ModelSelectionHost seam), an event bus, a
 * builtin command registry, and optional session store / effort / REPL options.
 */
export function buildHost<T extends TurnRunner & ModelSelectionHost = FakeRunner>(
  options: BuildHostOptions & { runner?: T } = {},
): { host: CliHost; runner: T; bus: EventBus } {
  const bus = options.bus ?? new EventBus();
  const runner = (options.runner ?? new FakeRunner()) as T;
  // Wire the fake runners' publish sink to the host bus (C# `new FakeRunner { Bus = bus }`).
  const publishable = runner as { bus?: EventBus };
  publishable.bus = bus;
  const service = options.service ?? new FakeLlm([]);
  const models = new ModelSelection(service, runner, {
    defaultProvider: "deepseek",
    ...(options.reasoningEffort !== undefined && options.reasoningEffort !== null
      ? { reasoningEffort: options.reasoningEffort }
      : {}),
  });
  const host: CliHost = {
    models,
    skills: options.skills ?? [],
    runner,
    bus,
    commands: options.commands ?? createBuiltinRegistry(),
    ...(options.sessionStore !== undefined ? { sessionStore: options.sessionStore } : {}),
    ...(options.reasoningEffort !== undefined && options.reasoningEffort !== null
      ? { reasoningEffort: options.reasoningEffort }
      : {}),
    ...(options.replOptions !== undefined ? { replOptions: options.replOptions } : {}),
  };
  return { host, runner, bus };
}
