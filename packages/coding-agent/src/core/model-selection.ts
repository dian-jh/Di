/**
 * Model selection for /model, RPC set_model and the model factory: resolve
 * first, check local auth, then commit. Mirrors `Di.Cli/ModelSelection.cs` and
 * `Core/Llm/ModelReference.cs` at baseline 09f4e08. Semantics:
 * - provider/model resolution: unique ID, unique prefix/substring match,
 *   ambiguity error, explicit provider route allows IDs absent from the
 *   advisory catalog;
 * - refresh failure keeps the last catalog snapshot (errors are returned, never
 *   thrown; the previous advisory list stays);
 * - a failed switch (ambiguous / not-found / missing auth) never changes the
 *   current model;
 * - a successful cross-provider switch resets the reasoning tier;
 * - a busy session (a turn is running) rejects switching.
 *
 * The {@link ModelService} is an advisory model catalog / provider seam (the
 * C# `ILlmService` subset ModelSelection uses); the actual LlmRuntime wiring is
 * a later phase. {@link ModelSelectionHost} mirrors C# `IAgentRunner.CurrentModel`
 * plus the reasoning-changed callback; the mode wiring (P6.3b) bridges it to
 * `AgentSession.setModel`.
 */

export type ModelSelectionErrorCode =
  | "invalid-query"
  | "ambiguous"
  | "not-found"
  | "missing-credential"
  | "unsupported-reasoning"
  | "busy";

/** A model-selection failure (the C# `ArgumentException` / `LlmException` contract, code-tagged). */
export class ModelSelectionError extends Error {
  readonly code: ModelSelectionErrorCode;

  constructor(code: ModelSelectionErrorCode, message: string) {
    super(message);
    this.name = "ModelSelectionError";
    this.code = code;
  }
}

/** One ordered opaque reasoning-effort ID a provider/model exposes (C# `ReasoningEffort`). */
export interface ReasoningEffortInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/** The reasoning capability of one exact provider/model route (C# `LlmModelReasoningInfo`). */
export interface ModelReasoningInfo {
  readonly efforts: readonly ReasoningEffortInfo[];
  readonly defaultEffort?: string;
}

/** A provider route's display metadata (C# `LlmProviderInfo`). */
export interface ProviderInfo {
  readonly id: string;
  readonly name: string;
}

/** One advisory model record (C# `LlmModelInfo`). */
export interface ModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Advertised context window; absent means unknown and must stay unbounded. */
  readonly contextWindow?: number;
  readonly reasoning?: ModelReasoningInfo;
}

/** Exact model metadata (C# `LlmResolvedModelInfo`). */
export interface ResolvedModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly contextWindow?: number;
  readonly reasoning?: ModelReasoningInfo;
}

/** Advisory model service seam (the C# `ILlmService` subset used by ModelSelection). */
export interface ModelService {
  listProviders(): readonly ProviderInfo[];
  listModels(provider?: string): readonly ModelInfo[];
  refreshModels(provider: string, signal?: AbortSignal): Promise<readonly ModelInfo[]>;
  checkAuth(provider: string, signal?: AbortSignal): Promise<boolean>;
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<ResolvedModelInfo>;
}

/** Host seam (C# `IAgentRunner.CurrentModel` + the reasoning-changed callback). */
export interface ModelSelectionHost {
  readonly currentModel: string;
  /** Whether a turn is currently running (busy policy rejects switching mid-turn). */
  isBusy(): boolean;
  /** Commit a model switch (C# `runner.CurrentModel = ...`). */
  setCurrentModel(model: string): void;
  /** Called when the reasoning tier changes (C# `onReasoningChanged`). */
  onReasoningChanged?(effort: string | null): void;
}

export interface ModelSelectionOptions {
  /** Provider used for unqualified references / short labels. Default "deepseek". */
  readonly defaultProvider?: string;
  /** Initial reasoning tier; `undefined` / null = no tier. */
  readonly reasoningEffort?: string | null;
}

const CHATGPT_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * A provider route and its opaque model ID. Only known provider prefixes are
 * split (C# `Core/Llm/ModelReference.cs`).
 */
export class ModelReference {
  readonly provider: string;
  readonly id: string;

  constructor(provider: string, id: string) {
    if (provider.length === 0) throw new ModelSelectionError("invalid-query", "Provider must not be empty.");
    if (id.length === 0) throw new ModelSelectionError("invalid-query", "Model ID must not be empty.");
    this.provider = provider;
    this.id = id;
  }

  get qualifiedId(): string {
    return `${this.provider}/${this.id}`;
  }

  /**
   * Split a reference string. When the prefix is a known provider route it is
   * taken as the provider and the rest (which may itself contain slashes) as
   * the opaque model ID; otherwise the whole text is an ID under
   * `defaultProvider`. A trailing slash (empty ID) is an error.
   */
  static parse(text: string, defaultProvider: string, providers: Iterable<string>): ModelReference {
    text = text.trim();
    if (text.length === 0) throw new ModelSelectionError("invalid-query", "Model must not be empty.");
    const slash = text.indexOf("/");
    let provider: string | undefined;
    if (slash > 0) {
      const prefix = text.slice(0, slash);
      for (const candidate of providers) {
        if (candidate.toLowerCase() === prefix.toLowerCase()) {
          provider = candidate;
          break;
        }
      }
    }
    if (provider === undefined) return new ModelReference(defaultProvider, text);
    if (slash === text.length - 1) throw new ModelSelectionError("invalid-query", "Model ID must not be empty.");
    return new ModelReference(provider, text.slice(slash + 1));
  }
}

/**
 * Shared by /model, RPC and the model factory: resolve first, check local auth,
 * then commit (C# `Di.Cli/ModelSelection.cs`).
 */
export class ModelSelection {
  private readonly service_: ModelService;
  private readonly host_: ModelSelectionHost;
  private readonly defaultProvider_: string;
  private reasoningEffort_: string | undefined;

  constructor(service: ModelService, host: ModelSelectionHost, options?: ModelSelectionOptions) {
    if (service == null) throw new TypeError("ModelSelection: service is required");
    if (host == null) throw new TypeError("ModelSelection: host is required");
    this.service_ = service;
    this.host_ = host;
    this.defaultProvider_ = options?.defaultProvider ?? "deepseek";
    this.reasoningEffort_ = options?.reasoningEffort ?? undefined;
  }

  get reasoningEffort(): string | undefined {
    return this.reasoningEffort_;
  }

  resolveCurrent(signal?: AbortSignal): Promise<ResolvedModelInfo> {
    return this.service_.resolveModel(this.current.provider, this.current.id, signal);
  }

  async setReasoning(value: string, signal?: AbortSignal): Promise<void> {
    if (this.host_.isBusy()) throw new ModelSelectionError("busy", "请等待当前回合结束后切换模型。");
    const effort = value.trim().toLowerCase();
    if (effort === "default") {
      this.changeReasoning_(null);
      return;
    }
    const model = await this.resolveCurrent(signal);
    if (model.reasoning !== undefined) {
      if (model.reasoning.efforts.every((e) => e.id !== effort)) {
        throw new ModelSelectionError(
          "unsupported-reasoning",
          "支持的推理强度: " + model.reasoning.efforts.map((e) => e.id).join(", "),
        );
      }
    } else if (this.current.provider !== "chatgpt" || !CHATGPT_REASONING_EFFORTS.includes(effort)) {
      throw new ModelSelectionError(
        "unsupported-reasoning",
        "无法确认此模型支持该推理强度。ChatGPT 使用 none/minimal/low/medium/high/xhigh/max 的模型相关子集。",
      );
    }
    this.changeReasoning_(effort);
  }

  /** The current model reference, parsed from the host's stored label. */
  get current(): ModelReference {
    return ModelReference.parse(this.host_.currentModel, this.defaultProvider_, this.providerIds_());
  }

  /** The advisory catalog across all providers. */
  list(): readonly ModelInfo[] {
    return this.service_.listModels();
  }

  /** Refresh every provider's advisory catalog; per-provider failures are returned as error strings, never thrown. */
  async refresh(signal?: AbortSignal): Promise<readonly string[]> {
    const errors: string[] = [];
    for (const provider of this.service_.listProviders()) {
      try {
        if (await this.service_.checkAuth(provider.id, signal)) {
          await this.service_.refreshModels(provider.id, signal);
        }
      } catch (error) {
        errors.push(`${provider.name}: ${errorMessage(error)}`);
      }
    }
    return errors;
  }

  async select(query: string, signal?: AbortSignal): Promise<ModelReference> {
    if (this.host_.isBusy()) throw new ModelSelectionError("busy", "请等待当前回合结束后切换模型。");
    query = query.trim();
    if (query.length === 0) throw new ModelSelectionError("invalid-query", "请指定模型。");

    const models = this.list();
    let exact = models.filter((m) => equal(`${m.provider}/${m.id}`, query));
    if (exact.length === 0) exact = models.filter((m) => equal(m.id, query));

    let selected: ModelReference;
    if (exact.length === 1) {
      selected = new ModelReference(exact[0]!.provider, exact[0]!.id);
    } else if (exact.length > 1) {
      throw this.ambiguous_(exact);
    } else {
      const reference = ModelReference.parse(query, this.current.provider, this.providerIds_());
      if (reference.id !== query) {
        selected = reference; // explicit provider: allow IDs missing from an advisory catalog
      } else {
        const q = query.toLowerCase();
        const matches = models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
        if (matches.length > 1) throw this.ambiguous_(matches);
        if (matches.length === 0) {
          throw new ModelSelectionError(
            "not-found",
            `未找到模型 ${query}。用 /model 查看目录，或用 provider/model 指定完整 ID。`,
          );
        }
        selected = new ModelReference(matches[0]!.provider, matches[0]!.id);
      }
    }

    if (!(await this.service_.checkAuth(selected.provider, signal))) {
      throw new ModelSelectionError(
        "missing-credential",
        `${selected.provider} 尚未配置凭据，请先登录或配置 API Key。`,
      );
    }

    const providerChanged = this.current.provider !== selected.provider;
    let incompatibleEffort = false;
    if (!providerChanged && this.reasoningEffort_ !== undefined) {
      const model = await this.service_.resolveModel(selected.provider, selected.id, signal);
      incompatibleEffort = model.reasoning !== undefined && model.reasoning.efforts.every((e) => e.id !== this.reasoningEffort_);
    }

    // Keep default-provider labels short while qualified references carry cross-provider routing.
    const nextLabel = selected.provider === this.defaultProvider_ ? selected.id : selected.qualifiedId;
    // Resolve the target before committing the label: a throwing host resolver
    // must leave the active model selection unchanged.
    this.host_.setCurrentModel(nextLabel);
    if (providerChanged || incompatibleEffort) this.changeReasoning_(null);
    return selected;
  }

  private changeReasoning_(effort: string | null): void {
    this.reasoningEffort_ = effort ?? undefined;
    this.host_.onReasoningChanged?.(effort);
  }

  private providerIds_(): string[] {
    const values: string[] = [];
    for (const provider of this.service_.listProviders()) values.push(provider.id);
    for (const model of this.list()) values.push(model.provider);
    values.push(this.defaultProvider_);
    return dedupeInsensitive(values);
  }

  private ambiguous_(matches: readonly ModelInfo[]): ModelSelectionError {
    return new ModelSelectionError(
      "ambiguous",
      "匹配到多个模型，请使用 provider/model：" + matches.map((m) => `${m.provider}/${m.id}`).join(", "),
    );
  }
}

function equal(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Case-insensitive de-dup preserving first-seen casing (C# `Distinct(OrdinalIgnoreCase)`). */
function dedupeInsensitive(values: Iterable<string>): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (!seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
