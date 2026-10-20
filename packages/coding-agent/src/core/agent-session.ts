import { randomUUID } from "node:crypto";
import type {
  AgentMessage,
  ChatModel,
  ModelRequest,
  ToolSpec,
} from "@di/ai";
import type {
  AgentEvent,
  AgentRequest,
  AgentResult,
  LoopCheckpoint,
  ToolExecutor,
  ToolValidator,
} from "@di/agent";
import { runAgentLoop } from "@di/agent";
import type { InputBudgetTracker } from "./budget.ts";

/**
 * AgentSession — the Node host that owns cross-turn state (loop-and-state.md
 * §"所有权与接口草案"): durable in-memory history, the current model, active
 * skills, the budget tracker, checkpoint/recovery and the soft-stop controller
 * live ONLY here. `runAgentLoop` (@di/agent) stays a pure loop that never
 * persists next-turn history.
 *
 * P2.6-card scope: cross-turn history, the environment snapshot, the budget
 * tracker and the busy/serialize policy of `runTurn`; model/skills switching
 * takes effect at turn boundaries; a `context_limit` pause preserves the
 * trajectory until `resetHistory`.
 */

/** Session-level rejection mirroring the RPC busy envelope code (`busy`). */
export class SessionBusyError extends Error {
  readonly code = "busy";

  constructor(message: string) {
    super(message);
    this.name = "SessionBusyError";
  }
}

/** One active skill injected into the volatile request tail (turn-boundary read). */
export interface ActiveSkill {
  readonly name: string;
  readonly instructions: string;
}

/** Stable session configuration (cross-turn ownership). */
export interface AgentSessionConfig {
  /** Stable system prompt injected first in every model request (loop prefix). */
  readonly systemPrompt: string;
  /** Model-facing tool schemas. */
  readonly tools?: readonly ToolSpec[];
  /**
   * Soft input budget (tokens) for history trimming and the loop's context guard.
   * `undefined` = no known model window → no invented token limit.
   */
  readonly tokenBudget?: number;
  /** Explicit whole-turn fallback used ONLY when tokenBudget is undefined; 0 (default) = no cap. */
  readonly maxHistoryTurns?: number;
  /** When set, a stable environment snapshot is appended as a history system message only on change. */
  readonly workingDirectory?: string;
  /** Optional shared tracker the host reads for L1 predictions; the session feeds ESTIMATED values only. */
  readonly budgetTracker?: InputBudgetTracker;
  readonly checkpoint?: LoopCheckpoint;
  readonly events?: (event: AgentEvent) => void | Promise<void>;
  readonly onObserverError?: (error: unknown, event: AgentEvent) => void | Promise<void>;
  readonly toolValidator?: ToolValidator;
}

/** Per-session injected dependencies passed through to the loop. */
export interface AgentSessionDeps {
  model: ChatModel;
  toolExecutor: ToolExecutor;
  /** Pure or injected estimate helper; never a Node Buffer API. */
  estimateRequestTokens: (request: ModelRequest) => number;
}

/** Per-turn input for {@link AgentSession.runTurn}. */
export interface SessionTurnOptions {
  readonly userMessage: string;
  /** Optional volatile context appended at the request tail (on top of active skills). */
  readonly systemContext?: string;
  readonly maxIterations?: number;
  readonly maxTokens?: number;
  readonly reasoningEffort?: string;
  readonly finalOutputTool?: string;
  readonly signal?: AbortSignal;
}

/**
 * The only session-turn entry. One session serializes turns: a concurrent prompt
 * (or reset) is rejected per the busy policy; `resetHistory` is only effective
 * when no turn is running. Each turn merges the full loop trajectory into
 * cross-turn memory, trims oldest whole user-turns by the estimated budget
 * (keeping the most recent turn), then sanitizes only the tail before persisting
 * — the returned result trajectory is never rewritten.
 */
export class AgentSession {
  private readonly config_: AgentSessionConfig;
  private readonly deps_: AgentSessionDeps;
  private readonly sessionId_ = `session-${randomUUID()}`;
  private history_: AgentMessage[] = [];
  private model_: ChatModel;
  private activeSkills_: readonly ActiveSkill[] = [];

  constructor(config: AgentSessionConfig, deps: AgentSessionDeps) {
    if (config == null) throw new TypeError("AgentSession: config is required");
    if (deps == null) throw new TypeError("AgentSession: deps are required");
    if (deps.model == null) throw new TypeError("AgentSession: deps.model is required");
    if (deps.toolExecutor == null) throw new TypeError("AgentSession: deps.toolExecutor is required");
    const maxHistoryTurns = config.maxHistoryTurns ?? 0;
    if (!Number.isInteger(maxHistoryTurns) || maxHistoryTurns < 0) {
      throw new RangeError(
        `AgentSession: maxHistoryTurns must be an integer >= 0 (0 = no cap), got ${maxHistoryTurns}`,
      );
    }
    if (config.tokenBudget !== undefined && (!Number.isInteger(config.tokenBudget) || config.tokenBudget < 0)) {
      throw new RangeError(`AgentSession: tokenBudget must be an integer >= 0, got ${config.tokenBudget}`);
    }
    this.config_ = config;
    this.deps_ = deps;
    this.model_ = deps.model;
  }

  /** Cross-turn memory currently held by the session (read-only view). */
  get history(): readonly AgentMessage[] {
    return this.history_;
  }

  /** The model used by the next turn (changes take effect at turn boundaries). */
  get currentModel(): ChatModel {
    return this.model_;
  }

  /** Swap the model; takes effect at the next turn boundary, never mid-stream. */
  setModel(model: ChatModel): void {
    if (model == null) throw new TypeError("AgentSession.setModel: model is required");
    this.model_ = model;
  }

  /** Active skills currently injected (turn-boundary read; full skills system is a later P6 card). */
  get activeSkills(): readonly ActiveSkill[] {
    return this.activeSkills_;
  }

  /** Swap active skills; takes effect at the next turn boundary. */
  setActiveSkills(skills: readonly ActiveSkill[]): void {
    this.activeSkills_ = [...skills];
  }

  /** Request a soft stop for the running turn (the loop polls it at phase boundaries). */
  requestSoftStop(): void {
    // Scaffold: soft-stop wiring lands with the P2.6 implementation.
  }

  /** Clear all cross-turn memory. Only allowed when no turn is running. */
  resetHistory(): void {
    // Scaffold: busy policy / full reset lands with the P2.6 implementation.
    this.history_ = [];
  }

  /**
   * The only session-turn entry. Scaffold: delegates to the pure loop and returns
   * the result WITHOUT the host behavior (history persistence, busy rejection,
   * snapshot, budget tracker, preserve flag, soft-stop wiring). Each business
   * assertion in `agent-session.test.ts` fails until the host logic lands.
   */
  async runTurn(options: SessionTurnOptions): Promise<AgentResult> {
    const request: AgentRequest = {
      sessionId: this.sessionId_,
      systemPrompt: this.config_.systemPrompt,
      userMessage: options.userMessage,
      history: this.history_,
      tools: this.config_.tools ?? [],
      contextTokenBudget: this.config_.tokenBudget,
      maxIterations: options.maxIterations,
      maxTokens: options.maxTokens,
      reasoningEffort: options.reasoningEffort,
      finalOutputTool: options.finalOutputTool,
    };
    return runAgentLoop(
      request,
      {
        model: this.model_,
        toolExecutor: this.deps_.toolExecutor,
        estimateRequestTokens: this.deps_.estimateRequestTokens,
      },
      options.signal,
    );
  }
}
