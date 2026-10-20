import type { AgentEvent } from "@di/agent";

/**
 * Turn lifecycle events the run log consumes but which are NOT part of the
 * @di/agent loop event set (C# `Core/AgentLoop/RunEvents.cs` at 09f4e08: these
 * deliberately do NOT inherit AgentLoopEvent — RPC/TUI consume AgentLoopEvent
 * with a full switch, so a new member would expand the wire protocol).
 *
 * In TS the {@link EventBus} fans out to every pull consumer, so the bus must
 * runtime-filter: only AgentEvent reaches consumers (see
 * `isAgentEvent`); these lifecycle events travel only through push handlers
 * (C# "向上派发以发布时静态类型为天花板").
 */

/** One agent run starting (the user input entering the runner). C# `RunStarted`. */
export interface RunStartedEvent {
  readonly type: "runStarted";
  readonly userMessage: string;
}

/** A model call starting for iteration N. C# `ModelCallStarted`. */
export interface ModelCallStartedEvent {
  readonly type: "modelCallStarted";
  readonly iteration: number;
}

/** The full event set the bus can carry: loop events + logging lifecycle events. */
export type LogEvent = AgentEvent | RunStartedEvent | ModelCallStartedEvent;

/** Narrow: is this event part of the @di/agent loop event set (consumer-visible)? */
export function isAgentEvent(event: LogEvent): event is AgentEvent {
  switch (event.type) {
    case "textDelta":
    case "reasoningDelta":
    case "toolCallDelta":
    case "turnCompleted":
    case "toolStarted":
    case "toolCompleted":
    case "runFailed":
    case "interrupted":
      return true;
    default:
      return false;
  }
}
