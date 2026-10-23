import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolCall } from "@di/ai";
import type { ToolExecutor, ToolObservation } from "@di/agent";
import { estimateTokenCount } from "./budget.ts";
import { OUTPUT_HEAD_CHARS, OUTPUT_MAX_CHARS, OUTPUT_TAIL_CHARS } from "./tools/output-buffer.ts";

export interface BudgetPolicyOptions {
  marginRatio?: number;
  outputReserveTokens?: number;
  nextOutputReserveTokens?: number;
  softRatio?: number;
  hardRatio?: number;
  blockingRatio?: number;
}

function clamp01(value: number): number { return Math.min(1, Math.max(0, value)); }
function roundToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Context-window reserve and waterline policy, matching. */
export class BudgetPolicy {
  readonly window: number;
  readonly outputReserveTokens: number;
  readonly marginTokens: number;
  readonly inputBudget: number;
  readonly nextOutputReserveTokens: number;
  readonly softRatio: number;
  readonly hardRatio: number;
  readonly blockingRatio: number;
  readonly softThreshold: number;
  readonly hardThreshold: number;
  readonly blockingThreshold: number;

  constructor(window: number, options: BudgetPolicyOptions = {}) {
    if (!Number.isFinite(window)) throw new RangeError("BudgetPolicy: window must be finite");
    this.window = Math.max(0, Math.trunc(window));
    this.softRatio = clamp01(options.softRatio ?? 0.7);
    this.hardRatio = clamp01(options.hardRatio ?? 0.8);
    this.blockingRatio = clamp01(options.blockingRatio ?? 0.9);
    if (this.softRatio > this.hardRatio || this.hardRatio > this.blockingRatio) {
      throw new RangeError("BudgetPolicy: waterline order must be soft <= hard <= blocking");
    }
    this.marginTokens = roundToEven(this.window * clamp01(options.marginRatio ?? 0.1));
    this.outputReserveTokens = Math.max(0, Math.trunc(options.outputReserveTokens ?? 20_000));
    this.nextOutputReserveTokens = Math.max(0, Math.trunc(options.nextOutputReserveTokens ?? 0));
    this.inputBudget = Math.max(0, this.window - this.outputReserveTokens - this.marginTokens);
    this.softThreshold = roundToEven(this.inputBudget * this.softRatio);
    this.hardThreshold = roundToEven(this.inputBudget * this.hardRatio);
    this.blockingThreshold = roundToEven(this.inputBudget * this.blockingRatio);
  }

  waterlineFor(tokens: number): "under" | "soft" | "hard" | "blocking" {
    if (tokens >= this.blockingThreshold) return "blocking";
    if (tokens >= this.hardThreshold) return "hard";
    if (tokens >= this.softThreshold) return "soft";
    return "under";
  }

  predictsOverSoft(current: number, nextTool: number, nextOutput = this.nextOutputReserveTokens): boolean {
    return BudgetPolicy.predict(current, nextTool, nextOutput) >= this.softThreshold;
  }

  static predict(current: number, nextTool: number, nextOutput: number): number {
    return Math.max(0, current) + Math.max(0, nextTool) + Math.max(0, nextOutput);
  }
}

/** Artifact storage rooted at DI_HOME/sessions/YYYY/MM/DD/artifacts. */
export class FileArtifactStore {
  private static sequence_ = 0;
  private readonly directory_: string;
  constructor(root: string, private readonly clock: () => Date = () => new Date(), private readonly pid: () => number = () => process.pid) {
    const now = clock();
    this.directory_ = join(root, "sessions", String(now.getUTCFullYear()).padStart(4, "0"), String(now.getUTCMonth() + 1).padStart(2, "0"), String(now.getUTCDate()).padStart(2, "0"), "artifacts");
  }

  write(toolName: string, content: string): string {
    const now = this.clock();
    mkdirSync(this.directory_, { recursive: true });
    const safe = toolName.replace(/[^A-Za-z0-9_-]/g, "-") || "tool";
    const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    const path = join(this.directory_, `tool-${safe}-${stamp}-p${this.pid()}-${String(++FileArtifactStore.sequence_).padStart(4, "0")}.txt`);
    writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
    return path;
  }
}

export interface ArtifactStore { write(toolName: string, content: string): string }

const CLEARABLE = new Set(["read_file", "grep", "glob", "bash", "cmd", "powershell", "python"]);

/** L1 executor decorator: persist oversized retrieval output before it enters trajectory. */
export class CompactingExecutor implements ToolExecutor {
  constructor(
    private readonly inner: ToolExecutor,
    private readonly artifacts: ArtifactStore,
    private readonly policyProvider: () => BudgetPolicy | undefined,
    private readonly currentInputTokens: () => number = () => 0,
  ) {}

  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolObservation> {
    const result = await this.inner.execute(call, signal);
    if (!CLEARABLE.has(call.name)) return result;
    const policy = this.policyProvider();
    if (policy === undefined || !policy.predictsOverSoft(this.currentInputTokens(), estimateTokenCount(result.text))) return result;
    // Match the baseline invariant: a preview that is not strictly smaller is never persisted.
    if (result.text.length <= OUTPUT_MAX_CHARS) return result;
    try {
      const path = this.artifacts.write(call.name, result.text);
      const head = result.text.slice(0, OUTPUT_HEAD_CHARS);
      const tail = result.text.slice(-OUTPUT_TAIL_CHARS);
      const dropped = result.text.length - head.length - tail.length;
      const summary = `[工具结果输出过大：完整 ${result.text.length} 字符（约 ${estimateTokenCount(result.text)} token）已保存到 ${path}，可用 read_file 读取]\n${head}\n…[省略中间 ${dropped} 字符]…\n${tail}`;
      if (summary.length < result.text.length) return { ...result, text: summary };
      try { const { unlinkSync } = await import("node:fs"); unlinkSync(path); } catch { /* orphan cleanup is best effort */ }
      return result;
    } catch {
      return result;
    }
  }
}

