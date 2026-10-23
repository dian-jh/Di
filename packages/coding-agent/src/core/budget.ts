import type { AgentMessage, ContentBlock, ReasoningBlock } from "@di/ai";
import { textOfMessage } from "@di/ai";

function isReasoningBlock(block: ContentBlock): block is ReasoningBlock {
  return block.type === "reasoning";
}

/*
 * Cross-turn memory / budget estimation helpers (pure; no Node Buffer or file API).
 *
 * the `EstimateTokens` +
 *: a rough ~4 characters/token estimate over each
 * message's visible text (plus assistant reasoning). This feeds the budget
 * tracker and history trimming — it is an approximate heuristic, never a provider
 * tokenizer's exact count (loop-and-state.md §AgentSession 历史与恢复).
 */

/** Rough token estimate for one text (`TokenEstimator.Estimate`): ceil(len / 4). */
export function estimateTokenCount(text: string): number {
  return text === "" ? 0 : Math.ceil(text.length / 4);
}

/** Estimate the tokens of a history/trajectory (visible text + assistant reasoning). */
export function estimateMemoryTokens(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokenCount(textOfMessage(message));
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (isReasoningBlock(block)) {
          total += estimateTokenCount(block.text);
        }
      }
    }
  }
  return total;
}

/*
 * B_current shared holder.
 * The session updates it with ESTIMATED values (never billed usage): before each
 * tool execution with the current turn's accumulated trajectory, and at turn end
 * with the trimmed cross-turn memory. Pure state; no IO.
 */
export class InputBudgetTracker {
  private current_ = 0;

  /** Current accumulated input-token estimate (>= 0; 0 until the first update). */
  get currentTokens(): number {
    return this.current_;
  }

  /** Write the latest estimate; negative values clamp to 0. */
  update(tokens: number): void {
    this.current_ = Math.max(0, tokens);
  }
}
