/**
 * Recovery reader / validation + resume state machine (P5).
 *
 * docs/migration/typescript-core/sessions-and-compatibility.md §"原子性、恢复
 * 状态机与错误处理"; C# baseline `Core/Sessions/SessionRecovery.cs` `Load` plus
 * the migration-mandated corrections:
 *  - unknown top-level / checkpoint record types are REJECTED with the line number
 *    (the C# baseline silently ignored them; a record may be completion evidence),
 *  - all field access failures normalize to line-numbered `SessionDataError`
 *    (never the C# baseline's raw `GetProperty` exceptions),
 *  - unknown content block types are rejected (`unknown-block`), never dropped.
 *
 * Only a torn FINAL line (no LF) is silently dropped. Any complete LF line that
 * is malformed, out of order, duplicated, orphaned or mismatched rejects the
 * whole file with the physical line number. A started tool with no durable
 * completed outcome is `unknown-outcome` — replay is forbidden and the host must
 * fail closed until an explicit reset.
 */

import { readFileSync } from "node:fs";
import type { AgentMessage, ContentBlock, ToolCall } from "@di/ai";
import { parseCheckpointMessage, parseEnvelopeLine, requireArray, requireField, requireString } from "./codec.ts";
import { SessionDataError } from "./errors.ts";

/** Fixed English observation for an assistant tool call that never started before the checkpoint. */
export const RECOVERY_NOT_EXECUTED_NOTE =
  "Recovery note: this tool call was not executed before the checkpoint. Decide whether it is still needed.";

/**
 * Load the last recoverable trajectory from a session JSONL file.
 *
 * The whole file is validated; the recovered trajectory is rebuilt from the LAST
 * `checkpoint_turn_started` snapshot (its `history` + `user`) plus the durable
 * messages/results appended after it. Completed tool results are preserved; a
 * tool call that never started receives the explicit "not executed" observation;
 * a started-but-unfinished tool rejects the recovery (`unknown-outcome`).
 */
export function loadRecovery(path: string): AgentMessage[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new SessionDataError("corrupt", `无法读取会话文件: ${path}`, { cause });
  }
  // The writer never emits a BOM; a stray BOM at the head is tolerated.
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // A torn final append (no LF) is the only byte-level damage that is ignored.
  if (text.length > 0 && !text.endsWith("\n")) {
    const lastNewline = text.lastIndexOf("\n");
    text = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
  }

  const trajectory: AgentMessage[] = [];
  let hasCheckpoint = false;
  const started = new Map<string, string>(); // call_id -> tool name (pending outcome)
  let activeCalls = new Set<string>(); // tool call ids of the current assistant batch
  const completedCalls = new Set<string>();
  let lineNumber = 0;

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue; // blank lines are ignored (C# RemoveEmptyEntries)
    lineNumber += 1;
    const envelope = parseEnvelopeLine(line, lineNumber);
    const payload = envelope.payload;
    switch (envelope.type) {
      // Known audit records are ignored (they are not checkpoints).
      case "session_meta":
      case "event_msg":
      case "turn_context":
      case "response_item":
        break;
      case "checkpoint_turn_started": {
        if (started.size > 0) throw unknownOutcome(started);
        hasCheckpoint = true;
        activeCalls = new Set();
        completedCalls.clear();
        trajectory.length = 0;
        for (const item of requireArray(payload, "history", lineNumber)) {
          trajectory.push(parseCheckpointMessage(item, lineNumber));
        }
        trajectory.push(parseCheckpointMessage(requireField(payload, "user", lineNumber), lineNumber));
        break;
      }
      case "trajectory_checkpoint": {
        const message = parseCheckpointMessage(requireField(payload, "message", lineNumber), lineNumber);
        if (message.role === "assistant") {
          if (started.size > 0) throw unknownOutcome(started);
          activeCalls = new Set(message.content.filter(isToolCall).map((call) => call.id));
          completedCalls.clear();
        }
        trajectory.push(message);
        break;
      }
      case "checkpoint_tool_started": {
        const callId = requireString(payload, "call_id", lineNumber);
        const name = requireString(payload, "name", lineNumber);
        if (!activeCalls.has(callId) || completedCalls.has(callId) || started.has(callId)) {
          throw new SessionDataError("corrupt", `Orphan or duplicate tool-start record '${callId}'.`, {
            lineNumber,
          });
        }
        started.set(callId, name);
        break;
      }
      case "checkpoint_tool_completed": {
        const id = requireString(payload, "call_id", lineNumber);
        if (!started.has(id)) {
          throw new SessionDataError("corrupt", `Tool completion '${id}' has no matching started record.`, {
            lineNumber,
          });
        }
        if (completedCalls.has(id)) {
          throw new SessionDataError("corrupt", `Duplicate tool completion '${id}'.`, { lineNumber });
        }
        const completedMessage = parseCheckpointMessage(requireField(payload, "message", lineNumber), lineNumber);
        if (completedMessage.role !== "tool" || completedMessage.toolCallId !== id) {
          throw new SessionDataError("corrupt", `Tool completion record '${id}' contains a mismatched result.`, {
            lineNumber,
          });
        }
        started.delete(id);
        completedCalls.add(id);
        trajectory.push(completedMessage);
        break;
      }
      case "checkpoint_turn_completed":
        break; // a completion marker; nothing to track for recovery
      default:
        throw new SessionDataError(
          "unknown-record",
          `Unknown session record type '${envelope.type}' at line ${lineNumber}.`,
          { lineNumber, recordType: envelope.type },
        );
    }
  }

  if (started.size > 0) throw unknownOutcome(started);
  if (!hasCheckpoint) {
    throw new SessionDataError(
      "no-checkpoint",
      "This session has no recovery checkpoints. Sessions written by older versions cannot be resumed.",
    );
  }

  return repairBatches(trajectory);
}

/**
 * Validate and repair each assistant call batch locally. Call ids may legally
 * repeat in later responses; within one batch a call must be unique. A tool
 * result with no preceding assistant batch is corruption; a call with no result
 * gets the explicit "not executed" observation so the model can re-decide.
 */
function repairBatches(trajectory: readonly AgentMessage[]): AgentMessage[] {
  const repaired: AgentMessage[] = [];
  for (let i = 0; i < trajectory.length; ) {
    const message = trajectory[i]!;
    if (message.role === "assistant" && message.content.some(isToolCall)) {
      const calls = message.content.filter(isToolCall);
      const ids = new Set(calls.map((call) => call.id));
      if (ids.size !== calls.length) {
        throw new SessionDataError("corrupt", "Duplicate tool call id in one assistant checkpoint.");
      }
      repaired.push(message);
      i += 1;
      const results = new Set<string>();
      while (i < trajectory.length && trajectory[i]!.role === "tool") {
        const toolResult = trajectory[i]!;
        if (toolResult.role !== "tool") throw new SessionDataError("corrupt", "unreachable");
        if (!ids.has(toolResult.toolCallId) || results.has(toolResult.toolCallId)) {
          throw new SessionDataError("corrupt", `Orphan or duplicate tool result '${toolResult.toolCallId}'.`);
        }
        results.add(toolResult.toolCallId);
        repaired.push(toolResult);
        i += 1;
      }
      for (const call of calls) {
        if (!results.has(call.id)) {
          repaired.push({
            role: "tool",
            toolCallId: call.id,
            content: RECOVERY_NOT_EXECUTED_NOTE,
            isError: false,
          });
        }
      }
      continue;
    }
    if (message.role === "tool") {
      throw new SessionDataError("corrupt", `Tool result '${message.toolCallId}' has no preceding assistant call batch.`);
    }
    repaired.push(message);
    i += 1;
  }
  return repaired;
}

/** Unknown-outcome rejection listing every pending call id (and its tool name). */
function unknownOutcome(started: ReadonlyMap<string, string>): SessionDataError {
  const details = [...started.entries()].map(([id, name]) => `${id} (${name})`).join(", ");
  return new SessionDataError("unknown-outcome", `Recovery stopped because tool execution outcome is unknown: ${details}`);
}

function isToolCall(block: ContentBlock): block is ToolCall {
  return block.type === "tool-call";
}
