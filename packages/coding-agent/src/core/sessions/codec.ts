/*
 * Checkpoint envelope + message/block codec.
 *
 * 逐行 envelope" / §"实时 checkpoint record 与完整示例"; * `Append` / `SerializeCheckpointMessage` /
 * `SerializeCheckpointBlock` and `ReadMessage`.
 *
 * The writer emits a stable `{timestamp, ordinal, type, payload}` envelope (raw
 * UTF-8, null omitted, snake_case payload). The in-memory `tool-call` block maps
 * to the wire `tool_call`. The TS writer REJECTS a block it cannot serialize —
 * the `{type:"unknown"}` write / read asymmetry is deliberately not
 * copied. The reader is strict: unknown roles/blocks and missing/mistyped fields
 * become line-numbered `SessionDataError`s, never low-level exceptions.
 */

import type { AgentMessage, ContentBlock, FileBlock, ImageBlock, OpaqueBlock, ReasoningBlock, ToolCall } from "@di/ai";
import { isTextBlock } from "@di/ai";
import { SessionDataError } from "./errors.ts";

/** A parsed session envelope (one JSONL record). */
export interface SessionEnvelope {
  readonly timestamp: string;
  readonly ordinal: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** `SessionLog.Now`: UTC milliseconds with a `Z` suffix (`yyyy-MM-dd'T'HH:mm:ss.fff'Z'`). */
export function nowUtcIso(): string {
  return new Date().toISOString();
}

/** Serialize one envelope line with the stable `{timestamp, ordinal, type, payload}` key order. */
export function serializeEnvelope(
  type: string,
  payload: Record<string, unknown>,
  ordinal: number,
  timestamp: string,
): string {
  return JSON.stringify({ timestamp, ordinal, type, payload });
}

/** Parse one envelope line; JSON/type failures normalize to line-numbered `SessionDataError`. */
export function parseEnvelopeLine(line: string, lineNumber: number): SessionEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    throw new SessionDataError("corrupt", `Invalid session record at line ${lineNumber}.`, { lineNumber, cause });
  }
  const obj = requireRecord(parsed, lineNumber);
  const type = requireString(obj, "type", lineNumber);
  const payload = requireField(obj, "payload", lineNumber);
  const payloadRecord = requireRecord(payload, lineNumber);
  const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : "";
  const ordinal = typeof obj.ordinal === "number" ? obj.ordinal : -1;
  return { timestamp, ordinal, type, payload: payloadRecord };
}

/** Wire shape of a checkpoint message (snake_case, null omitted, field order fixed). */
export function serializeCheckpointMessage(message: AgentMessage): Record<string, unknown> {
  switch (message.role) {
    case "system":
      return { role: "system", text: message.text };
    case "user":
      return { role: "user", blocks: message.content.map(serializeCheckpointBlock) };
    case "assistant":
      return { role: "assistant", blocks: message.content.map(serializeCheckpointBlock) };
    case "tool":
      return { role: "tool", call_id: message.toolCallId, text: message.content, is_error: message.isError };
  }
}

/** Wire shape of one checkpoint content block. Unknown blocks are refused, never written. */
export function serializeCheckpointBlock(block: ContentBlock): Record<string, unknown> {
  // NOTE: `OpaqueBlock.type` is `string & {}` (it holds the plugin's actual type
  // string), so `ContentBlock` is not a proper discriminated union — narrowing via
  // switch on `block.type` fails. Use type predicates. A plugin's opaque block is
  // detected by its `rawJson` field and serialized FIRST, matching the current behavior
  // where `SerializeCheckpointBlock` switches on CLR type (an OpaqueBlock always
  // writes `{type:"opaque", unknown_type, raw_json}` regardless of its type string).
  if (isOpaqueBlock(block)) return { type: "opaque", unknown_type: block.type, raw_json: block.rawJson };
  if (isTextBlock(block)) return { type: "text", text: block.text };
  if (isReasoningBlock(block)) return { type: "reasoning", text: block.text };
  if (isToolCallBlock(block)) return { type: "tool_call", id: block.id, name: block.name, arguments: block.arguments };
  if (isImageBlock(block)) {
    return block.detail === undefined
      ? { type: "image", attachment_id: block.attachmentId }
      : { type: "image", attachment_id: block.attachmentId, detail: block.detail };
  }
  if (isFileBlock(block)) {
    return block.filename === undefined
      ? { type: "file", attachment_id: block.attachmentId }
      : { type: "file", attachment_id: block.attachmentId, filename: block.filename };
  }
  throw new SessionDataError(
    "cannot-serialize",
    `Unsupported checkpoint block type: ${(block as { readonly type: string }).type}`,
  );
}

function isReasoningBlock(block: ContentBlock): block is ReasoningBlock {
  return block.type === "reasoning";
}

function isToolCallBlock(block: ContentBlock): block is ToolCall {
  return block.type === "tool-call";
}

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === "image";
}

function isFileBlock(block: ContentBlock): block is FileBlock {
  return block.type === "file";
}

function isOpaqueBlock(block: ContentBlock): block is OpaqueBlock {
  // OpaqueBlock.type is the plugin's own string (e.g. `custom_block`), so the
  // discriminator cannot be `"opaque"`. Only OpaqueBlock carries a `rawJson`
  // string field; no whitelisted in-memory block has one.
  return typeof (block as { readonly rawJson?: unknown }).rawJson === "string";
}

/** Parse a checkpoint message back into the in-memory vocabulary (strict, line-numbered). */
export function parseCheckpointMessage(value: unknown, lineNumber?: number): AgentMessage {
  const obj = requireRecord(value, lineNumber);
  const role = requireString(obj, "role", lineNumber);
  switch (role) {
    case "system":
      return { role: "system", text: requireString(obj, "text", lineNumber) };
    case "tool": {
      const callId = requireString(obj, "call_id", lineNumber);
      const text = requireString(obj, "text", lineNumber);
      const isError = obj.is_error === undefined ? false : requireBoolean(obj, "is_error", lineNumber);
      return { role: "tool", toolCallId: callId, content: text, isError };
    }
    case "user":
    case "assistant": {
      const blocks = requireArray(obj, "blocks", lineNumber).map((block) => parseCheckpointBlock(block, lineNumber));
      return role === "user" ? { role: "user", content: blocks } : { role: "assistant", content: blocks };
    }
    default:
      throw new SessionDataError("corrupt", `Unknown checkpoint role '${role}' at line ${lineNumber}.`, {
        lineNumber,
      });
  }
}

/** Parse one checkpoint block; unknown block types are rejected with the line number. */
export function parseCheckpointBlock(value: unknown, lineNumber?: number): ContentBlock {
  const obj = requireRecord(value, lineNumber);
  const type = requireString(obj, "type", lineNumber);
  switch (type) {
    case "text":
      return { type: "text", text: requireString(obj, "text", lineNumber) };
    case "reasoning":
      return { type: "reasoning", text: requireString(obj, "text", lineNumber) };
    case "tool_call":
      return {
        type: "tool-call",
        id: requireString(obj, "id", lineNumber),
        name: requireString(obj, "name", lineNumber),
        arguments: requireString(obj, "arguments", lineNumber),
      };
    case "image": {
      const attachmentId = requireString(obj, "attachment_id", lineNumber);
      return obj.detail === undefined
        ? { type: "image", attachmentId }
        : { type: "image", attachmentId, detail: requireString(obj, "detail", lineNumber) };
    }
    case "file": {
      const attachmentId = requireString(obj, "attachment_id", lineNumber);
      return obj.filename === undefined
        ? { type: "file", attachmentId }
        : { type: "file", attachmentId, filename: requireString(obj, "filename", lineNumber) };
    }
    case "opaque":
      return {
        type: requireString(obj, "unknown_type", lineNumber) as string & {},
        rawJson: requireString(obj, "raw_json", lineNumber),
      };
    default:
      throw new SessionDataError(
        "unknown-block",
        `Unknown checkpoint content block type '${type}' at line ${lineNumber}.`,
        { lineNumber, recordType: type },
      );
  }
}

// ---------------------------------------------------------------------------
// Field access helpers (all failures carry a physical line number)
// ---------------------------------------------------------------------------

/** Require `value` to be a plain JSON object. */
export function requireRecord(value: unknown, lineNumber: number | undefined): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionDataError("corrupt", `Expected an object at line ${lineNumber}.`, { lineNumber });
  }
  return value as Record<string, unknown>;
}

/** Require `obj[key]` to be present and a string. */
export function requireString(
  obj: Record<string, unknown>,
  key: string,
  lineNumber: number | undefined,
): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw new SessionDataError("corrupt", `Expected string field '${key}' at line ${lineNumber}.`, { lineNumber });
  }
  return value;
}

/** Require `obj[key]` to be present and a boolean. */
export function requireBoolean(
  obj: Record<string, unknown>,
  key: string,
  lineNumber: number | undefined,
): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") {
    throw new SessionDataError("corrupt", `Expected boolean field '${key}' at line ${lineNumber}.`, { lineNumber });
  }
  return value;
}

/** Require `obj[key]` to be present. */
export function requireField(obj: Record<string, unknown>, key: string, lineNumber: number | undefined): unknown {
  if (!(key in obj)) {
    throw new SessionDataError("corrupt", `Missing field '${key}' at line ${lineNumber}.`, { lineNumber });
  }
  return obj[key];
}

/** Require `obj[key]` to be present and an array. */
export function requireArray(obj: Record<string, unknown>, key: string, lineNumber: number | undefined): unknown[] {
  const value = requireField(obj, key, lineNumber);
  if (!Array.isArray(value)) {
    throw new SessionDataError("corrupt", `Expected array field '${key}' at line ${lineNumber}.`, { lineNumber });
  }
  return value;
}
