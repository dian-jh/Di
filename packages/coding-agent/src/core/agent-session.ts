import { randomUUID } from "node:crypto";
import type {
  AgentMessage,
  ChatModel,
  ModelRequest,
  ToolSpec,
} from "@di/ai";
import type {
  AgentDependencies,
  AgentEvent,
  AgentRequest,
  AgentResult,
  LoopCheckpoint,
  ToolExecutor,
  ToolValidator,
} from "@di/agent";
import { runAgentLoop } from "@di/agent";
import { InputBudgetTracker, estimateMemoryTokens } from "./budget.ts";
import { buildEnvironmentSnapshot } from "./environment-snapshot.ts";
import {
  dropOldestTurns,
  sanitizeHistory,
  trimHistoryByTokens,
  trimHistoryByTurns,
  userMessageCount,
} from "./history.ts";

/**
 * AgentSession — the Node host that owns cross-turn state (loop-and-state.md
 * §"所有权与接口草案"): durable in-memory history, the current model, active
 * skills, the budget tracker, checkpoint/recovery and the soft-stop controller
 * live ONLY here. `runAgentLoop` (@di/agent) stays a pure loop that never
 * persists next-turn history.
 *
 * P2.6-card behavior (mirrors `Core/AgentLoop/AgentRunner.cs` `RunAsync`):
 * - `runTurn` is the only session-turn entry; one session serializes turns
 *   (concurrent prompt or `resetHistory` while a turn is running → busy).
 * - each turn merges the full loop trajectory into cross-turn memory, trims
 *   oldest whole user-turns by the estimated budget (keeping the most recent
 *   turn), then sanitizes only the tail (`SanitizeHistory`) before persisting —
 *   the returned result trajectory is never rewritten;
 * - a `context_limit` stop sets `preserveHistoryUntilReset` so the next turn does
 *   not auto-trim that paused trajectory / generate a summary;
 * - model/skills changes take effect at turn boundaries (`setModel` /
 *   `setActiveSkills` are read at turn start, never mid-stream);
 * - a stable environment snapshot is appended as a history system message only
 *   when its text changes (never re-injecting stable prefix bytes each turn);
 * - the budget tracker feeds ESTIMATED values (never billed usage): it sees the
 *   current turn's accumulated assistant/tool trajectory before tool execution
 *   and the trimmed memory estimate at turn end; no model window → no invented
 *   token limit (`maxHistoryTurns` is only an explicit positive-number fallback
 *   when there is no token budget).
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
  private preserveHistoryUntilReset_ = false;
  private lastHistoryBudget_: number | undefined;
  private lastSnapshotText_: string | undefined;
  private running_ = false;
  private softStopRequested_ = false;
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
    this.softStopRequested_ = true;
  }

  /**
   * Clear all cross-turn memory. Only allowed when no turn is running — the
   * in-use array is never cleared concurrently (loop-and-state.md §"中断、取消与
   * 并发生命周期"). Mirrors C# `AgentRunner.ResetHistory` (snapshot marker and
   * budget tracker holder are reset too so the snapshot is re-injected next turn).
   */
  resetHistory(): void {
    if (this.running_) {
      throw new SessionBusyError("AgentSession: cannot reset history while a turn is running");
    }
    this.history_ = [];
    this.preserveHistoryUntilReset_ = false;
    this.lastHistoryBudget_ = undefined;
    this.lastSnapshotText_ = undefined;
    this.config_.budgetTracker?.update(0);
  }

  /**
   * The only session-turn entry. A concurrent prompt is rejected per the busy
   * policy. Each turn:
   * 1. trims existing memory when the budget shrank (or this is the first turn)
   *    and history is not being preserved,
   * 2. appends the stable environment snapshot only when its text changed,
   * 3. pre-trims oldest whole user-turns while the full incoming-request estimate
   *    exceeds the budget (mirroring C# `EstimateIncomingRequestTokens`),
   * 4. runs the pure loop with `beforeToolExecution` feeding the budget tracker
   *    the accumulated trajectory (estimated values only),
   * 5. persists the trajectory: `context_limit` preserves it verbatim and sets
   *    `preserveHistoryUntilReset`; other stops trim oldest whole user-turns by
   *    budget (falling back to `maxHistoryTurns` only when no budget exists) then
   *    sanitize the tail — the returned result trajectory is never rewritten.
   */
  async runTurn(options: SessionTurnOptions): Promise<AgentResult> {
    if (this.running_) {
      throw new SessionBusyError("AgentSession: a turn is already running; concurrent prompt rejected (busy policy)");
    }
    this.running_ = true;
    try {
      const tokenBudget = this.config_.tokenBudget;
      const maxHistoryTurns = this.config_.maxHistoryTurns ?? 0;
      // Turn-boundary model read: setModel takes effect only here, never mid-stream.
      const model = this.model_;

      // Start-of-turn trim when the budget shrank (or this is the first turn) and
      // history is not being preserved (C# `_lastHistoryBudget is null ||
      // SoftThreshold < _lastHistoryBudget`). Trims whole user-turns, keeps the
      // most recent one, then sanitizes; a still-over-budget history is cleared.
      if (
        !this.preserveHistoryUntilReset_ &&
        tokenBudget !== undefined &&
        (this.lastHistoryBudget_ === undefined || tokenBudget < this.lastHistoryBudget_)
      ) {
        const trimmed = sanitizeHistory(trimHistoryByTokens(this.history_, tokenBudget));
        this.history_ = estimateMemoryTokens(trimmed) > tokenBudget ? [] : [...trimmed];
        if (this.lastSnapshotText_ !== undefined && !this.history_.some((m) => m.role === "system" && m.text === this.lastSnapshotText_)) {
          this.lastSnapshotText_ = undefined;
        }
        this.syncTracker_(this.history_);
      }

      // Stable environment snapshot: appended as a history system message only
      // when the text changes — never re-injecting stable prefix bytes per turn.
      if (this.config_.workingDirectory !== undefined) {
        const snapshot = buildEnvironmentSnapshot(this.config_.workingDirectory);
        if (snapshot !== this.lastSnapshotText_) {
          this.lastSnapshotText_ = snapshot;
          this.history_ = [...this.history_, { role: "system", text: snapshot }];
        }
      }

      // Volatile skill context at the request tail (turn-boundary active skills).
      const skillContext = buildSkillContext(this.activeSkills_);
      const systemContext = combineSystemContext(skillContext, options.systemContext);

      // Whole-request pre-trim (C# `EstimateIncomingRequestTokens`): drop oldest
      // whole user-turns while the estimate of the incoming request exceeds the
      // budget and more than one user turn remains. Skipped while preserving a
      // paused trajectory (context_limit).
      if (!this.preserveHistoryUntilReset_ && tokenBudget !== undefined && tokenBudget > 0) {
        while (
          userMessageCount(this.history_) > 1 &&
          this.estimateIncomingRequest_(this.history_, options.userMessage, systemContext) > tokenBudget
        ) {
          this.history_ = [...dropOldestTurns(this.history_, 1)];
        }
      }

      const request: AgentRequest = {
        sessionId: this.sessionId_,
        systemPrompt: this.config_.systemPrompt,
        userMessage: options.userMessage,
        history: this.history_,
        tools: this.config_.tools ?? [],
        contextTokenBudget: tokenBudget,
        maxIterations: options.maxIterations,
        maxTokens: options.maxTokens,
        reasoningEffort: options.reasoningEffort,
        finalOutputTool: options.finalOutputTool,
        ...(systemContext !== undefined ? { systemContext } : {}),
      };

      const dependencies: AgentDependencies = {
        model,
        toolExecutor: this.deps_.toolExecutor,
        estimateRequestTokens: this.deps_.estimateRequestTokens,
        beforeToolExecution: (trajectory) => this.syncTracker_(trajectory),
        interruptRequested: () => this.softStopRequested_,
        ...(this.config_.events !== undefined ? { events: this.config_.events } : {}),
        ...(this.config_.onObserverError !== undefined ? { onObserverError: this.config_.onObserverError } : {}),
        ...(this.config_.checkpoint !== undefined ? { checkpoint: this.config_.checkpoint } : {}),
        ...(this.config_.toolValidator !== undefined ? { toolValidator: this.config_.toolValidator } : {}),
      };

      const result = await runAgentLoop(request, dependencies, options.signal);

      // Turn end: persist cross-turn memory. `context_limit` is an explicit pause
      // (C# `AgentStopReason.ContextLimit`): the trajectory is preserved verbatim
      // and the next turn does not auto-trim it or generate a summary
      // (preserveHistoryUntilReset). Other stops trim oldest whole user-turns by
      // the estimated budget (falling back to `maxHistoryTurns` only when no
      // budget exists), then sanitize only the tail — the result trajectory is
      // never rewritten.
      if (result.stopReason === "context_limit") {
        this.history_ = [...result.trajectory];
        this.preserveHistoryUntilReset_ = true;
      } else {
        const trimmed =
          tokenBudget !== undefined
            ? trimHistoryByTokens(result.trajectory, tokenBudget)
            : trimHistoryByTurns(result.trajectory, maxHistoryTurns);
        this.history_ = [...sanitizeHistory(trimmed)];
        this.preserveHistoryUntilReset_ = false;
      }
      this.lastHistoryBudget_ = tokenBudget;
      // Trimming may have cut the earliest snapshot out of history: reset the
      // marker so the next turn re-injects it (a long session never loses the
      // environment context).
      if (this.lastSnapshotText_ !== undefined && !this.history_.some((m) => m.role === "system" && m.text === this.lastSnapshotText_)) {
        this.lastSnapshotText_ = undefined;
      }
      this.syncTracker_(this.history_);
      return result;
    } finally {
      this.running_ = false;
      // Never carry a stale soft-stop flag or signal into the next turn.
      this.softStopRequested_ = false;
    }
  }

  /** Whole-request estimate mirroring the loop's buildModelRequest (system + trajectory + volatile tail). */
  private estimateIncomingRequest_(
    history: readonly AgentMessage[],
    userMessage: string,
    systemContext: string | undefined,
  ): number {
    const messages: AgentMessage[] = [];
    if (this.config_.systemPrompt.trim().length > 0) {
      messages.push({ role: "system", text: this.config_.systemPrompt });
    }
    messages.push(...history);
    messages.push({ role: "user", content: [{ type: "text", text: userMessage }] });
    if (systemContext !== undefined && systemContext.trim().length > 0) {
      messages.push({ role: "system", text: systemContext });
    }
    return this.deps_.estimateRequestTokens({ messages, tools: this.config_.tools });
  }

  /** Feed the shared tracker an ESTIMATED value (never billed usage). */
  private syncTracker_(messages: readonly AgentMessage[]): void {
    this.config_.budgetTracker?.update(estimateMemoryTokens(messages));
  }
}

/** Active-skill instructions injected at the request tail (turn-boundary read). */
function buildSkillContext(activeSkills: readonly ActiveSkill[]): string | undefined {
  if (activeSkills.length === 0) return undefined;
  return activeSkills.map((skill) => `【已激活 Skill：${skill.name}】\n${skill.instructions}`).join("\n\n");
}

/** Combine active-skill context with an optional per-turn volatile system context. */
function combineSystemContext(
  skillContext: string | undefined,
  turnContext: string | undefined,
): string | undefined {
  if (skillContext === undefined) return turnContext;
  if (turnContext === undefined || turnContext.trim().length === 0) return skillContext;
  return skillContext + "\n\n" + turnContext;
}
