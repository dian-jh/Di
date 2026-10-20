import type { ChatModel, ModelEvent, ModelRequest } from "@di/ai";
import type { EventBus } from "./event-bus.ts";

/**
 * Host-side model wrapper that publishes {@link ModelCallStartedEvent} on every
 * model call (C# `ReAct.RunCoreAsync` emits `ModelCallStarted(iterations)` right
 * before each model await — the TS `@di/agent` loop deliberately emits no
 * call-start, so the composition root wraps the resolved ChatModel here instead
 * of modifying packages/agent/).
 *
 * The loop calls the model exactly once per iteration, so this wrapper's
 * per-instance call counter IS the loop's iteration counter. The composition
 * root resolves a FRESH probe-wrapped model at each turn boundary
 * (`AgentSessionConfig.resolveModel`), so the counter restarts at 0 every turn —
 * the `iteration` numbers published here match the `turnCompleted.iteration` the
 * loop reports, which lets `DiLog` pair `llm: call_started iteration=N` with
 * `llm: call_completed iteration=N duration_ms=…`.
 */
export class ModelCallProbe implements ChatModel {
  private readonly inner_: ChatModel;
  private readonly bus_: EventBus;
  private iteration_ = 0;

  constructor(inner: ChatModel, bus: EventBus) {
    if (inner == null) throw new TypeError("ModelCallProbe: inner model is required");
    if (bus == null) throw new TypeError("ModelCallProbe: bus is required");
    this.inner_ = inner;
    this.bus_ = bus;
  }

  /** Model calls observed since this instance was created (the loop's iteration counter). */
  get iteration(): number {
    return this.iteration_;
  }

  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    this.iteration_ += 1;
    this.bus_.publish({ type: "modelCallStarted", iteration: this.iteration_ });
    return this.inner_.stream(request, signal);
  }
}
