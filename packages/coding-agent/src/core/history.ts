import type { AgentMessage, ContentBlock, ToolCall } from "@di/ai";
import { estimateMemoryTokens } from "./budget.ts";

function isToolCallBlock(block: ContentBlock): block is ToolCall {
  return block.type === "tool-call";
}

/**
 * Cross-turn history helpers (pure; mirrors `Core/AgentLoop/AgentRunner.cs`
 * `TrimHistoryByTokens` / `TrimHistory` / `DropOldestTurns` / `SanitizeHistory`).
 * All operate on the persisted memory only — the loop's result trajectory is
 * never rewritten by these functions (loop-and-state.md §"逐单元红绿实施与验收
 * 边界" history/recovery row: 结果 trajectory 不改写，持久 history 良构).
 */

/** Count user messages (whole-turn boundaries) in a history. */
export function userMessageCount(messages: readonly AgentMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role === "user") count += 1;
  }
  return count;
}

/** Drop the oldest `toDrop` whole user-turns (each turn starts at a user message). */
export function dropOldestTurns(
  messages: readonly AgentMessage[],
  toDrop: number,
): readonly AgentMessage[] {
  let seen = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message !== undefined && message.role === "user" && seen++ === toDrop) {
      return messages.slice(i);
    }
  }
  return messages;
}

/**
 * Trim oldest whole user-turns until the estimated memory fits `tokenBudget`,
 * always keeping the most recent turn (a single over-budget turn is retained).
 * A null/non-positive budget returns the input unchanged (the caller then falls
 * back to the explicit whole-turn heuristic).
 */
export function trimHistoryByTokens(
  trajectory: readonly AgentMessage[],
  tokenBudget: number | undefined,
): readonly AgentMessage[] {
  if (tokenBudget === undefined || tokenBudget <= 0) return trajectory;
  const userCount = userMessageCount(trajectory);
  if (userCount <= 1 || estimateMemoryTokens(trajectory) <= tokenBudget) return trajectory;
  for (let toDrop = 1; toDrop < userCount; toDrop++) {
    const remaining = dropOldestTurns(trajectory, toDrop);
    if (estimateMemoryTokens(remaining) <= tokenBudget) return remaining;
  }
  return dropOldestTurns(trajectory, userCount - 1);
}

/**
 * Explicit whole-turn fallback used only when no token budget exists: keep the
 * most recent `maxTurns` whole user-turns. `maxTurns <= 0` (default) disables
 * the cap and returns the input unchanged — never clears history and never
 * invents a token limit when no model window is known.
 */
export function trimHistoryByTurns(
  trajectory: readonly AgentMessage[],
  maxTurns: number,
): readonly AgentMessage[] {
  if (maxTurns <= 0) return trajectory;
  const userCount = userMessageCount(trajectory);
  if (userCount <= maxTurns) return trajectory;
  return dropOldestTurns(trajectory, userCount - maxTurns);
}

/**
 * Make persisted cross-turn memory tool-well-formed: an assistant's tool calls
 * must be followed by their tool results. Capped (`max_iterations`) or final-output
 * turns end with unexecuted tool calls — an unpaired group would make the next
 * provider request invalid; the whole group (assistant + any partial results) is
 * removed from the tail. Only the persisted memory is trimmed; the replayable
 * loop trajectory is never modified.
 */
export function sanitizeHistory(
  history: readonly AgentMessage[],
): readonly AgentMessage[] {
  let end = history.length;
  while (end > 0) {
    let assistantIndex = end - 1;
    while (assistantIndex >= 0 && history[assistantIndex]?.role === "tool") {
      assistantIndex--;
    }
    const assistant = assistantIndex >= 0 ? history[assistantIndex] : undefined;
    if (
      assistant === undefined ||
      assistant.role !== "assistant" ||
      assistant.content.every((block) => block.type !== "tool-call")
    ) {
      break;
    }
    const toolCalls = assistant.content.filter(isToolCallBlock);
    const resultIds = new Set<string>();
    for (let i = assistantIndex + 1; i < end; i++) {
      const message = history[i];
      if (message !== undefined && message.role === "tool") resultIds.add(message.toolCallId);
    }
    if (toolCalls.every((call) => resultIds.has(call.id))) break;
    end = assistantIndex;
  }
  return end === history.length ? history : history.slice(0, end);
}
