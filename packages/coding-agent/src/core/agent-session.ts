import { randomUUID } from "node:crypto";
import type {
  AgentMessage,
  ChatModel,
  ModelRequest,
  ToolSpec,
  TokenUsage,
  UsageCost,
} from "@di/ai";
import { combineCost, tokenUsageAdd, tokenUsageZero } from "@di/ai";
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
import type { SessionStore } from "./sessions/session-log.ts";
import { loadRecovery } from "./sessions/session-recovery.ts";
import { SessionDataError } from "./sessions/errors.ts";

/*
 * AgentSession — the Node host that owns cross-turn state (see
 * `docs/modules/sessions.md`): durable in-memory history, the current model, active
 * skills, the budget tracker, checkpoint/recovery and the soft-stop controller
 * live ONLY here. `runAgentLoop` (@di/agent) stays a pure loop that never
 * persists next-turn history.
 *
 * Model switching and turn behavior:
 * - `runTurn` is the only session-turn entry; one session serializes turns
 * (concurrent prompt or `resetHistory` while a turn is running → busy).
 * - each turn merges the full loop trajectory into cross-turn memory, trims
 * oldest whole user-turns by the estimated budget (keeping the most recent
 * turn), then sanitizes only the tail (`SanitizeHistory`) before persisting —
 * the returned result trajectory is never rewritten;
 * - a `context_limit` stop sets `preserveHistoryUntilReset` so the next turn does
 * not auto-trim that paused trajectory / generate a summary;
 * - model/skills changes take effect at turn boundaries (`setModel` /
 * `setActiveSkills` are read at turn start, never mid-stream): the model is
 * resolved at the start of `runTurn` (`config.resolveModel` when provided,
 * else the injected/current model) and captured for the whole turn — a
 * mid-turn `setModel` never replaces a running loop's dependency;
 * - a model-resolution failure rejects the turn at the boundary with an explicit
 * `SessionModelError` (code `model-resolve-failed`) — no silent fallback, no
 * invented token window — and leaves committed history untouched;
 * - the host accumulates each loop run's usage/cost into a cross-turn session
 * ledger (`usage` / `cost`) for L1 display and budget level; this is separate
 * from estimation — the budget tracker keeps feeding ESTIMATED values;
 * - a stable environment snapshot is appended as a history system message only
 * when its text changes (never re-injecting stable prefix bytes each turn);
 * - the budget tracker feeds ESTIMATED values (never billed usage): it sees the
 * current turn's accumulated assistant/tool trajectory before tool execution
 * and the trimmed memory estimate at turn end; no model window → no invented
 * token limit (`maxHistoryTurns` is only an explicit positive-number fallback
 * when there is no token budget).
 */

/** Session-level rejection mirroring the RPC busy envelope code (`busy`). */
export class SessionBusyError extends Error {
  readonly code = "busy";

  constructor(message: string) {
    super(message);
    this.name = "SessionBusyError";
  }
}

/*
 * The session is blocked from further turns because a started tool outcome is
 * unknown. Replay is forbidden: the
 * caller must inspect the side effects and call `resetHistory` (or start a new
 * session) before the same host may continue.
 */
export class SessionRecoveryBlockedError extends Error {
  readonly code = "recovery-blocked";

  constructor(message: string) {
    super(message);
    this.name = "SessionRecoveryBlockedError";
  }
}

/*
 * Model/provider resolution failure at the turn boundary.
 * Rejects the turn with an explicit error — never a silent fallback, never an
 * invented token window — and leaves committed cross-turn history untouched.
 */
export class SessionModelError extends Error {
  readonly code = "model-resolve-failed";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionModelError";
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
  /*
 * Optional turn-boundary model resolver. When provided, `runTurn` awaits it at the
 * turn boundary with the current model reference and uses the returned
 * `ChatModel` for THAT turn. A throwing / rejecting resolver (or one returning
 * no model) rejects the turn with `SessionModelError` — no silent fallback, no
 * invented token window — and does not disturb committed history. When absent,
 * the injected / `setModel`-swapped model is used directly.
 */
  readonly resolveModel?: (current: ChatModel) => ChatModel | Promise<ChatModel>;
  /** Model-facing tool schemas. */
  readonly tools?: readonly ToolSpec[];
  /*
 * Soft input budget (tokens) for history trimming and the loop's context guard.
 * `undefined` = no known model window → no invented token limit.
 */
  readonly tokenBudget?: number;
  /** Turn-boundary dynamic budget (for model switches); undefined means unknown window. */
  readonly tokenBudgetProvider?: () => number | undefined;
  /** Explicit whole-turn fallback used ONLY when tokenBudget is undefined; 0 (default) = no cap. */
  readonly maxHistoryTurns?: number;
  /** When set, a stable environment snapshot is appended as a history system message only on change. */
  readonly workingDirectory?: string;
  /** Optional shared tracker the host reads for L1 predictions; the session feeds ESTIMATED values only. */
  readonly budgetTracker?: InputBudgetTracker;
  readonly checkpoint?: LoopCheckpoint;
  /*
 * Durable session store: owns the JSONL checkpoint writes (`beginCheckpointTurn`
 * before each loop run, the loop's durable `LoopCheckpoint` seam, `completeCheckpointTurn`
 * at turn end) and the same-process recovery on a model/cancellation error — the host
 * reloads the durable checkpoint into memory and continues without re-executing tools;
 * a started-but-unfinished outcome blocks further turns until `resetHistory`. When set,
 * it takes precedence over `checkpoint` for the loop seam. Absent = no session log
 * (`--no-session`).
 */
  readonly sessionStore?: SessionStore;
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

/*
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
  /**: set when a started tool outcome is unknown. */
  private recoveryBlockedReason_: string | undefined;
  private lastHistoryBudget_: number | undefined;
  private lastSnapshotText_: string | undefined;
  private running_ = false;
  private softStopRequested_ = false;
  private model_: ChatModel;
  private activeSkills_: readonly ActiveSkill[] = [];
  /** Cross-turn usage ledger: each completed run's usage accumulated by the host. */
  private usage_: TokenUsage = tokenUsageZero();
  /** Cross-turn cost ledger; `undefined` until any turn reports cost (never fabricated as zero). */
  private cost_: UsageCost | undefined;

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

  /**
   * Cross-turn accumulated token usage across all completed turns (host ledger;
   * for L1 display / budget level). Each `runAgentLoop` result's usage is
   * accumulated here at turn end. This is distinct from the budget tracker,
   * which keeps feeding ESTIMATED values — never treat a display value as the
   * estimate truth.
   */
  get usage(): TokenUsage {
    return this.usage_;
  }

  /**
   * Cross-turn accumulated cost across all completed turns; `undefined` until any
   * turn reports cost (an unknown model rate is never fabricated as zero).
   */
  get cost(): UsageCost | undefined {
    return this.cost_;
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
   * in-use array is never cleared concurrently (see `docs/interrupt.md`). The
   * snapshot marker and
   * budget tracker holder are reset too so the snapshot is re-injected next turn).
   */
  resetHistory(): void {
    if (this.running_) {
      throw new SessionBusyError("AgentSession: cannot reset history while a turn is running");
    }
    this.history_ = [];
    this.preserveHistoryUntilReset_ = false;
    this.recoveryBlockedReason_ = undefined;
    this.lastHistoryBudget_ = undefined;
    this.lastSnapshotText_ = undefined;
    this.config_.budgetTracker?.update(0);
  }

  /**
   * Restore a validated session trajectory before the next explicit user turn
   * (; the `--resume` entry). The restored history
   * is treated as a paused trajectory (`preserveHistoryUntilReset`), so the next
   * turn does not auto-trim it; a `context_limit` pause preserves the restored
   * task and its tool results until a larger budget continues.
   */
  restoreHistory(history: readonly AgentMessage[]): void {
    this.history_ = [...history];
    this.preserveHistoryUntilReset_ = true;
    this.recoveryBlockedReason_ = undefined;
    this.lastHistoryBudget_ = undefined;
    let snapshot: string | undefined;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i];
      if (message?.role === "system") {
        snapshot = message.text;
        break;
      }
    }
    this.lastSnapshotText_ = snapshot;
  }

  /**
   * The only session-turn entry. A concurrent prompt is rejected per the busy
   * policy. Each turn:
   * 1. trims existing memory when the budget shrank (or this is the first turn)
   *    and history is not being preserved,
   * 2. appends the stable environment snapshot only when its text changed,
   * 3. pre-trims oldest whole user-turns while the full incoming-request estimate
   *    exceeds the budget (mirroring ),
   * 4. runs the pure loop with `beforeToolExecution` feeding the budget tracker
   *    the accumulated trajectory (estimated values only),
   * 5. persists the trajectory: `context_limit` preserves it verbatim and sets
   *    `preserveHistoryUntilReset`; other stops trim oldest whole user-turns by
   *    budget (falling back to `maxHistoryTurns` only when no budget exists) then
   *    sanitize the tail — the returned result trajectory is never rewritten.
   */
  async runTurn(options: SessionTurnOptions): Promise<AgentResult> {
    if (this.recoveryBlockedReason_ !== undefined) {
      throw new SessionRecoveryBlockedError(
        "会话恢复检测到工具执行结果未知。请先核查副作用并调用 ResetHistory() 或启动新会话。" + this.recoveryBlockedReason_,
      );
    }
    if (this.running_) {
      throw new SessionBusyError("AgentSession: a turn is already running; concurrent prompt rejected (busy policy)");
    }
    this.running_ = true;
    try {
      const maxHistoryTurns = this.config_.maxHistoryTurns ?? 0;
      // Turn-boundary model resolution: setModel takes effect only here, never
      // mid-stream. The resolved model is captured for the whole turn, so a
      // mid-turn setModel (e.g. while blocked on a GatedModel) can never replace
      // a running loop's dependency.
      const model = await this.resolveModel_();
      const tokenBudget = this.config_.tokenBudgetProvider !== undefined
        ? this.config_.tokenBudgetProvider()
        : this.config_.tokenBudget;
      if (tokenBudget !== undefined && (!Number.isInteger(tokenBudget) || tokenBudget < 0)) {
        throw new RangeError(`AgentSession: token budget must be an integer >= 0, got ${tokenBudget}`);
      }

      // Start-of-turn trim when the budget shrank (or this is the first turn) and
      // history is not being preserved (`_lastHistoryBudget is null ||
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

      // Whole-request pre-trim (`EstimateIncomingRequestTokens`): drop oldest
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

      const sessionStore = this.config_.sessionStore;
      const checkpoint = sessionStore ?? this.config_.checkpoint;

      const dependencies: AgentDependencies = {
        model,
        toolExecutor: this.deps_.toolExecutor,
        estimateRequestTokens: this.deps_.estimateRequestTokens,
        beforeToolExecution: (trajectory) => this.syncTracker_(trajectory),
        interruptRequested: () => this.softStopRequested_,
        ...(this.config_.events !== undefined ? { events: this.config_.events } : {}),
        ...(this.config_.onObserverError !== undefined ? { onObserverError: this.config_.onObserverError } : {}),
        ...(checkpoint !== undefined ? { checkpoint } : {}),
        ...(this.config_.toolValidator !== undefined ? { toolValidator: this.config_.toolValidator } : {}),
      };

      // Durable turn-start checkpoint (`CheckpointLog?.BeginCheckpointTurn`):
      // a snapshot of the current history + the user message is durable before
      // any model work. A failed write aborts the turn before any side effect.
      if (sessionStore !== undefined) {
        sessionStore.beginCheckpointTurn(options.userMessage, Date.now(), this.history_);
      }

      let result: AgentResult;
      try {
        result = await runAgentLoop(request, dependencies, options.signal);
      } catch (error) {
        // Same-process recovery (`RunAsync` catch): refresh the in-memory
        // history from the durable checkpoint so the SAME host can continue
        // without re-executing tools. A started-but-unfinished outcome blocks
        // further turns (fail closed) until an explicit reset.
        if (sessionStore !== undefined) {
          try {
            const recovered = loadRecovery(sessionStore.logFilePath);
            this.history_ = [...recovered];
            this.preserveHistoryUntilReset_ = true;
            this.recoveryBlockedReason_ = undefined;
          } catch (recoveryError) {
            if (recoveryError instanceof SessionDataError && recoveryError.code === "unknown-outcome") {
              this.recoveryBlockedReason_ = recoveryError.message;
            } else {
              this.recoveryBlockedReason_ = "Recovery checkpoint could not be validated; inspect the session log before continuing.";
            }
          }
        }
        throw error;
      }

      // Turn end: persist cross-turn memory. `context_limit` is an explicit pause
      // (`AgentStopReason.ContextLimit`): the trajectory is preserved verbatim
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
      // Cross-turn usage/cost ledger: each loop run's usage/cost is accumulated
      // here by the host (accounting), for L1 display / budget level. The
      // budget tracker is NOT updated from these values — it keeps feeding
      // ESTIMATED values only (never treat a UI-display value as the truth).
      this.usage_ = tokenUsageAdd(this.usage_, result.usage);
      this.cost_ = combineCost(this.cost_, result.cost);
      // Durable turn-completion marker (`CheckpointLog?.CompleteCheckpointTurn`),
      // after the in-memory history/ledger commit. If this write fails the turn
      // result was still fully persisted as earlier checkpoints and remains recoverable.
      if (sessionStore !== undefined) {
        sessionStore.completeCheckpointTurn(result);
      }
      return result;
    } finally {
      this.running_ = false;
      // Never carry a stale soft-stop flag or signal into the next turn.
      this.softStopRequested_ = false;
    }
  }

  /*
 * Resolve the model for THIS turn at the turn boundary (* `_modelFactory(CurrentModel)` / `ILlmService.ResolveModelAsync`). Without a
 * configured resolver the injected/current model is returned; with one, the
 * resolver is awaited with the current model reference. A throwing / rejecting
 * resolver (or one returning no model) is surfaced as an explicit
 * `SessionModelError` — no silent fallback, no invented token window.
 */
  private async resolveModel_(): Promise<ChatModel> {
    const resolve = this.config_.resolveModel;
    if (resolve === undefined) return this.model_;
    let resolved: ChatModel;
    try {
      resolved = await resolve(this.model_);
    } catch (error) {
      if (error instanceof SessionModelError) throw error;
      throw new SessionModelError(
        "AgentSession: model resolution failed at the turn boundary (no silent fallback)",
        { cause: error },
      );
    }
    if (resolved == null) {
      throw new SessionModelError("AgentSession: model resolver returned no model (no silent fallback)");
    }
    return resolved;
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
