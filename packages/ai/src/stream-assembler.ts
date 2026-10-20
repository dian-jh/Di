import type { ContentBlock } from "./types/content.ts";
import type { AssistantMessage } from "./types/messages.ts";
import type { FinishReason, ModelResponse, TokenUsage } from "./types/model.ts";
import type { ModelEvent } from "./types/stream.ts";

/**
 * P3 provider chunk assembler (Di baseline `Core/Llm/ChatAssembler.cs` +
 * `Core/Llm/ChatModelClient.cs`; TS contract per architecture.md
 * §"AI Provider 流与模型事件分层" and models-and-auth.md).
 *
 * The low-level provider chunk vocabulary is consumed only here — it never leaks
 * to the agent loop. {@link ProviderStreamAssembler} forwards high-level deltas
 * as they arrive and produces exactly one final `completed` carrying the complete
 * {@link ModelResponse}.
 */

/** Block kind carried by a {@link ProviderChunk} `blockStart`. */
export type ProviderBlockStart =
  | { readonly type: "text" }
  | { readonly type: "reasoning" }
  | { readonly type: "tool-call" }
  | { readonly type: "opaque"; readonly blockType: string; readonly rawJson: string };

/**
 * Low-level provider stream protocol (from Di baseline `Core/Llm/StreamChunk.cs`).
 *
 * Protocol obligations on the emitting adapter:
 * - `usage` precedes `finish`; nothing may follow `finish`.
 * - tool-call `arguments` travel as raw JSON text deltas and are never parsed or
 *   reshaped here; only the complete block reaches the agent loop.
 * - a block `index` is allocated in first-seen order and reused for every delta
 *   of the same block; each index appears at most once in a stream.
 * - in-band terminal errors use `finish` with an error/aborted reason; transport
 *   failures instead throw out of the adapter before any `finish`.
 */
export type ProviderChunk =
  | { readonly type: "blockStart"; readonly index: number; readonly block: ProviderBlockStart }
  | { readonly type: "textDelta"; readonly index: number; readonly delta: string }
  | { readonly type: "reasoningDelta"; readonly index: number; readonly delta: string }
  | { readonly type: "toolCallDelta"; readonly index: number; readonly id?: string; readonly name?: string; readonly argumentsDelta: string }
  | { readonly type: "blockEnd"; readonly index: number }
  | { readonly type: "responseInfo"; readonly responseId?: string }
  | { readonly type: "usage"; readonly usage: TokenUsage }
  | { readonly type: "finish"; readonly reason: FinishReason };

/**
 * Structured protocol violation raised by {@link ProviderStreamAssembler}.
 * `code` is a stable, machine-readable discriminator. It is distinct from
 * in-band terminal failures, which ride on `completed.response.finishReason`.
 */
export class AssemblerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AssemblerError";
    this.code = code;
  }
}

/** Options for {@link ProviderStreamAssembler}. */
export interface ProviderStreamAssemblerOptions {
  /** Model id actually invoked; carried into {@link ModelResponse.model}. */
  readonly model: string;
  /** Request start in Unix milliseconds; defaults to construction time. */
  readonly timestamp?: number;
}

/** A block currently being assembled, keyed by its provider index. */
type OpenBlock =
  | { readonly kind: "text"; text: string }
  | { readonly kind: "reasoning"; text: string }
  | { readonly kind: "tool-call"; id?: string; name?: string; arguments: string }
  | { readonly kind: "opaque"; readonly blockType: string; readonly rawJson: string };

/**
 * Assembles a {@link ProviderChunk} sequence into a {@link ModelEvent} sequence,
 * assembling content per block `index` (multiple interleaved blocks never share
 * a buffer).
 *
 * - `add` returns zero or more delta events; it throws {@link AssemblerError} on
 *   invalid sequencing.
 * - `finish` returns exactly one `completed` carrying the complete
 *   {@link ModelResponse}. It throws rather than fabricating a success when the
 *   stream ended without a `finish` chunk (missing terminal).
 */
export class ProviderStreamAssembler {
  private readonly open = new Map<number, OpenBlock>();
  private readonly closed = new Map<number, ContentBlock>();
  private readonly model: string;
  private readonly timestamp: number;
  private readonly startedAt: number;
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private responseId: string | undefined;
  private finishReason: FinishReason | undefined;
  private completedEvent: ModelEvent | undefined;

  constructor(options: ProviderStreamAssemblerOptions) {
    this.model = options.model;
    this.timestamp = options.timestamp ?? Date.now();
    this.startedAt = performance.now();
  }

  /** Feed one provider chunk; returns any high-level delta events it produced. */
  add(chunk: ProviderChunk): readonly ModelEvent[] {
    if (this.finishReason !== undefined) {
      throw new AssemblerError("chunk-after-finish", `chunk ${chunk.type} received after finish`);
    }
    switch (chunk.type) {
      case "blockStart":
        return this.startBlock(chunk.index, chunk.block);
      case "textDelta":
        return this.textDelta(chunk.index, chunk.delta);
      case "reasoningDelta":
        return this.reasoningDelta(chunk.index, chunk.delta);
      case "toolCallDelta":
        return this.toolCallDelta(chunk.index, chunk.id, chunk.name, chunk.argumentsDelta);
      case "blockEnd":
        this.endBlock(chunk.index);
        return [];
      case "responseInfo":
        // Keep the first reported response id (models-and-auth.md: 首个 response id).
        if (this.responseId === undefined && chunk.responseId !== undefined) {
          this.responseId = chunk.responseId;
        }
        return [];
      case "usage":
        this.usage = chunk.usage;
        return [];
      case "finish":
        this.acceptFinish(chunk.reason);
        return [];
    }
  }

  /**
   * Finalize the stream and return the single `completed` event. Throws
   * `missing-finish` if no `finish` chunk was received, and `already-completed`
   * if called a second time.
   */
  finish(): ModelEvent {
    if (this.completedEvent !== undefined) {
      throw new AssemblerError("already-completed", "finish() has already produced the completed event");
    }
    if (this.finishReason === undefined) {
      const open = [...this.open.keys()].sort((a, b) => a - b);
      throw new AssemblerError(
        "missing-finish",
        open.length > 0
          ? `stream ended without a finish chunk (blocks still open: ${open.join(", ")})`
          : "stream ended without a finish chunk",
      );
    }

    const content: readonly ContentBlock[] = [...this.closed.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, block]) => block);
    const message: AssistantMessage = { role: "assistant", content };
    const response: ModelResponse = {
      message,
      finishReason: this.finishReason,
      usage: this.usage,
      model: this.model,
      timestamp: this.timestamp,
      durationMs: Math.max(0, performance.now() - this.startedAt),
      ...(this.responseId !== undefined ? { responseId: this.responseId } : {}),
    };
    const event: ModelEvent = { type: "completed", response };
    this.completedEvent = event;
    return event;
  }

  private startBlock(index: number, block: ProviderBlockStart): readonly ModelEvent[] {
    if (this.open.has(index) || this.closed.has(index)) {
      throw new AssemblerError("duplicate-block-start", `block ${index} already started or closed`);
    }
    switch (block.type) {
      case "text":
        this.open.set(index, { kind: "text", text: "" });
        break;
      case "reasoning":
        this.open.set(index, { kind: "reasoning", text: "" });
        break;
      case "tool-call":
        this.open.set(index, { kind: "tool-call", arguments: "" });
        break;
      case "opaque":
        this.open.set(index, { kind: "opaque", blockType: block.blockType, rawJson: block.rawJson });
        break;
    }
    return [];
  }

  private textDelta(index: number, delta: string): readonly ModelEvent[] {
    const block = this.requireOpenBlock(index, "textDelta");
    if (block.kind !== "text") {
      throw new AssemblerError("delta-type-mismatch", `textDelta for non-text block ${index}`);
    }
    block.text += delta;
    return [{ type: "textDelta", delta }];
  }

  private reasoningDelta(index: number, delta: string): readonly ModelEvent[] {
    const block = this.requireOpenBlock(index, "reasoningDelta");
    if (block.kind !== "reasoning") {
      throw new AssemblerError("delta-type-mismatch", `reasoningDelta for non-reasoning block ${index}`);
    }
    block.text += delta;
    return [{ type: "reasoningDelta", delta }];
  }

  private toolCallDelta(
    index: number,
    id: string | undefined,
    name: string | undefined,
    argumentsDelta: string,
  ): readonly ModelEvent[] {
    const block = this.requireOpenBlock(index, "toolCallDelta");
    if (block.kind !== "tool-call") {
      throw new AssemblerError("delta-type-mismatch", `toolCallDelta for non-tool-call block ${index}`);
    }
    if (id !== undefined) block.id = id;
    if (name !== undefined) block.name = name;
    block.arguments += argumentsDelta;
    return [{
      type: "toolCallDelta",
      id: block.id ?? `call_${index}`,
      name: block.name ?? "",
      // Cumulative raw JSON string, possibly still incomplete (loop-and-state.md).
      arguments: block.arguments,
    }];
  }

  private endBlock(index: number): void {
    const block = this.open.get(index);
    if (block === undefined) {
      throw new AssemblerError("block-end-without-start", `blockEnd for unknown or closed index ${index}`);
    }
    this.open.delete(index);
    this.closed.set(index, buildBlock(index, block));
  }

  private acceptFinish(reason: FinishReason): void {
    if (this.open.size > 0) {
      const open = [...this.open.keys()].sort((a, b) => a - b);
      throw new AssemblerError("unclosed-block", `finish received with open blocks: ${open.join(", ")}`);
    }
    this.finishReason = reason;
  }

  private requireOpenBlock(index: number, chunkType: string): OpenBlock {
    const block = this.open.get(index);
    if (block === undefined) {
      throw new AssemblerError("delta-without-block", `${chunkType} for unknown or closed index ${index}`);
    }
    return block;
  }
}

/** Convert one finished open block into the normalized content block. */
function buildBlock(index: number, block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "reasoning":
      return { type: "reasoning", text: block.text };
    case "tool-call":
      return {
        type: "tool-call",
        id: block.id ?? `call_${index}`,
        name: block.name ?? "",
        arguments: block.arguments.length === 0 ? "{}" : block.arguments,
      };
    case "opaque":
      return { type: block.blockType, rawJson: block.rawJson };
  }
}
