import type { AgentEvent } from "@di/agent";
import { isAgentEvent, type LogEvent } from "./log-events.ts";

/**
 * In-memory AgentLoopEvent bus (the C# `Common/Events/IEventBus.cs` +
 * `IEventConsumer.cs` counterpart at baseline 09f4e08): the mode bodies (REPL /
 * print / rpc) create a consumer BEFORE running a turn, the session's `events`
 * callback (or a test fake runner) publishes to the bus, and a concurrent render
 * task drains the consumer in real time. Single-threaded push/close semantics;
 * publishing is synchronous so event order == publish order.
 *
 * Two independent consumption channels coexist (C# push vs pull):
 * - pull consumers ({@link subscribe}) receive the @di/agent loop event set ONLY
 *   (C# type-capped upward dispatch: `runStarted` / `modelCallStarted` are
 *   log-only lifecycle events and must never reach the RPC/TUI full-switch
 *   consumers — see `docs/modules/logging.md` "关键约束");
 * - push handlers ({@link subscribeWith}) receive EVERY published event
 *   (C# `IEventBus.Subscribe<TEvent>`), which is how `DiLog` observes the
 *   turn lifecycle as a bypass side channel.
 */

/** One subscriber's FIFO view of the bus: push / close / async iteration / drain. */
export class EventConsumer implements AsyncIterable<AgentEvent> {
  private items: AgentEvent[] = [];
  private closed_ = false;
  private pending: ((result: IteratorResult<AgentEvent, undefined>) => void) | null = null;

  /** Append an event; ignored after close. */
  push(event: AgentEvent): void {
    if (this.closed_) return;
    this.items.push(event);
    this.settle_();
  }

  /** Signal end-of-stream; a pending `next()` is settled with the remaining items then done. */
  close(): void {
    this.closed_ = true;
    this.settle_();
  }

  /** Read one buffered event or `null` when the queue is empty (C# `TryRead`). */
  tryRead(): AgentEvent | null {
    if (this.items.length === 0) return null;
    return this.items.shift()!;
  }

  private settle_(): void {
    if (this.pending === null) return;
    const resolve = this.pending;
    this.pending = null;
    if (this.items.length > 0) resolve({ value: this.items.shift()!, done: false });
    else resolve({ value: undefined, done: true });
  }

  async next(): Promise<IteratorResult<AgentEvent, undefined>> {
    if (this.items.length > 0) return { value: this.items.shift()!, done: false };
    if (this.closed_) return { value: undefined, done: true };
    return new Promise<IteratorResult<AgentEvent, undefined>>((resolve) => {
      this.pending = resolve;
    });
  }

  [Symbol.asyncIterator](): EventConsumer {
    return this;
  }
}

/** A push subscriber receives every published event (C# `IEventBus.Subscribe` handler). */
export type EventHandler = (event: LogEvent) => void;

/** Fan-out event bus: a subscriber gets every published event in order. */
export class EventBus {
  private readonly consumers = new Set<EventConsumer>();
  private readonly handlers = new Set<EventHandler>();

  /** Create a consumer that receives every event from now on (loop event set only). */
  subscribe(): EventConsumer {
    const consumer = new EventConsumer();
    this.consumers.add(consumer);
    return consumer;
  }

  /**
   * Push-subscribe (C# `IEventBus.Subscribe<TEvent>`): the handler receives
   * EVERY published event, including the log-only lifecycle events. Returns an
   * unsubscribe token. A throwing handler is isolated and never breaks the bus
   * or the main flow (the run log is a bypass observation).
   */
  subscribeWith(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Publish one event (synchronous fan-out). Pull consumers see only the loop
   * event set; push handlers see everything.
   */
  publish(event: LogEvent): void {
    if (isAgentEvent(event)) {
      for (const consumer of this.consumers) consumer.push(event);
    }
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Exception isolation: a throwing observer must not break the bus or the main flow.
      }
    }
  }

  /** Detach + close a consumer (mode turn end). */
  release(consumer: EventConsumer): void {
    this.consumers.delete(consumer);
    consumer.close();
  }
}
