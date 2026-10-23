import type { ToolCall } from "@di/ai";
import type { ToolExecutor, ToolObservation } from "@di/agent";

/** One recorded invocation: the call plus its 1-based execution order. */
export interface ToolExecutionRecord {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  readonly order: number;
}

/**
 *
 * Implements the @di/agent ToolExecutor contract: it records every invocation
 * (call id / name / raw arguments / execution order) and returns canned results
 * produced by the injected handler. Used to prove the tool-round-trip fixture's
 * expected invocations can be replayed in order.
 */
export class RecordingExecutor implements ToolExecutor {
  private readonly calls_: ToolCall[] = [];
  private readonly canned_: (call: ToolCall) => ToolObservation;

  constructor(canned: (call: ToolCall) => ToolObservation) {
    this.canned_ = canned;
  }

  execute(call: ToolCall, _signal?: AbortSignal): Promise<ToolObservation> {
    this.calls_.push(call);
    return Promise.resolve(this.canned_(call));
  }

  /** Invocations in execution order. */
  get calls(): readonly ToolCall[] {
    return this.calls_;
  }

  /** Each invocation as id/name/arguments with 1-based execution order. */
  records(): readonly ToolExecutionRecord[] {
    return this.calls_.map((call, index) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      order: index + 1,
    }));
  }
}
