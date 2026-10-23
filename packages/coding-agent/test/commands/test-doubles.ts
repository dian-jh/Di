import type {
  CommandHost,
  ModelInfo,
  ModelReasoningInfo,
  ModelSelectionHost,
  ModelService,
  ProviderInfo,
  ResolvedModelInfo,
  Skill,
} from "@di/coding-agent";

/**
 *
 * FakeLlm / FakeRunner equivalents): a composite advisory model service with
 * per-provider adapters, and a recording host that implements both the command
 * host and the model-selection host seams.
 */

export const testSkill: Skill = {
  name: "backend-tests",
  description: "跑后端测试",
  instructions: "npm test",
  metadata: {},
  allowedTools: [],
  disableModelInvocation: false,
  directory: "",
};

/** One advisory model record for a fake adapter. */
export interface FakeModelSpec {
  readonly id: string;
  readonly name: string;
  readonly reasoning?: ModelReasoningInfo;
}


export class FakeAdapter {
  readonly provider: string;
  readonly providerName: string;
  configured = true;
  refreshes = 0;
  refreshError: Error | undefined;
  readonly models: readonly FakeModelSpec[];

  constructor(provider: string, models: readonly FakeModelSpec[], providerName?: string) {
    this.provider = provider;
    this.providerName = providerName ?? provider;
    this.models = models;
  }
}


export class FakeModelService implements ModelService {
  private readonly adapters_: FakeAdapter[] = [];

  register(adapter: FakeAdapter): void {
    this.adapters_.push(adapter);
  }

  listProviders(): readonly ProviderInfo[] {
    return this.adapters_.map((a) => ({ id: a.provider, name: a.providerName }));
  }

  listModels(provider?: string): readonly ModelInfo[] {
    const result: ModelInfo[] = [];
    for (const adapter of this.adapters_) {
      if (provider !== undefined && adapter.provider !== provider) continue;
      for (const spec of adapter.models) result.push({ provider: adapter.provider, id: spec.id, name: spec.name });
    }
    return result;
  }

  async refreshModels(provider: string, _signal?: AbortSignal): Promise<readonly ModelInfo[]> {
    const adapter = this.adapters_.find((a) => a.provider === provider);
    if (adapter === undefined) throw new Error(`refreshModels: unknown provider '${provider}'`);
    adapter.refreshes += 1;
    if (adapter.refreshError !== undefined) throw adapter.refreshError;
    return adapter.models.map((spec) => ({ provider, id: spec.id, name: spec.name }));
  }

  async checkAuth(provider: string, _signal?: AbortSignal): Promise<boolean> {
    const adapter = this.adapters_.find((a) => a.provider === provider);
    return adapter?.configured ?? false;
  }

  async resolveModel(provider: string, id: string, _signal?: AbortSignal): Promise<ResolvedModelInfo> {
    const adapter = this.adapters_.find((a) => a.provider === provider);
    const spec = adapter?.models.find((m) => m.id === id);
    if (spec === undefined) throw new Error(`resolveModel: unknown model '${provider}/${id}'`);
    return {
      provider,
      id,
      name: spec.name,
      ...(spec.reasoning !== undefined ? { reasoning: spec.reasoning } : {}),
    };
  }
}

/** Recording host implementing both the command host and the model-selection host seams. */
export class RecordingHost implements CommandHost, ModelSelectionHost {
  currentModel = "deepseek-flash";
  busy = false;
  resetCalls = 0;
  activeSkillNames: string[] = [];
  reasoningChanges: (string | null)[] = [];

  resetHistory(): void {
    this.resetCalls += 1;
  }

  setActiveSkills(skills: readonly Skill[]): void {
    this.activeSkillNames = skills.map((s) => s.name);
  }

  isBusy(): boolean {
    return this.busy;
  }

  setCurrentModel(model: string): void {
    this.currentModel = model;
  }

  onReasoningChanged(effort: string | null): void {
    this.reasoningChanges.push(effort);
  }
}
