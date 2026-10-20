import type { AgentEvent } from "@di/agent";

/**
 * In-memory AgentLoopEvent bus (the C# `Common/Events/IEventBus.cs` +
 * `IEventConsumer.cs` counterpart at baseline 09f4e08): the mode bodies (REPL /
 * print / rpc) create a consumer BEFORE running a turn, the session's `events`
 * callback (or a test fake runner) publishes to the bus, and a concurrent render
 * task drains the consumer in real time. Single-threaded push/close semantics;
 * publishing is synchronous so event order == publish order.
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

/** Fan-out event bus: a subscriber gets every published event in order. */
export class EventBus {
  private readonly consumers = new Set<EventConsumer>();

  /** Create a consumer that receives every event from now on. */
  subscribe(): EventConsumer {
    const consumer = new EventConsumer();
    this.consumers.add(consumer);
    return consumer;
  }

  /** Publish one event to every live consumer (synchronous fan-out). */
  publish(event: AgentEvent): void {
    for (const consumer of this.consumers) consumer.push(event);
  }

  /** Detach + close a consumer (mode turn end). */
  release(consumer: EventConsumer): void {
    this.consumers.delete(consumer);
    consumer.close();
  }
}
