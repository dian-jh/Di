/**
 * Bounded streaming output accumulators — SCAFFOLD for the P4.4 red tests.
 *
 * The public API surface is correct but the bounded-drop behavior is NOT yet
 * implemented: `text`/`toText` return the full accumulated content (no head/tail
 * truncation, no truncation notice), so every "over-budget keeps head and tail
 * with marker / total stays bounded" assertion fails red. The green commit
 * replaces this scaffold with the real head-6000/tail-18000 drop-as-you-go
 * implementation (port of `Core/Tools/OutputBuffer.cs` and
 * `Core/Tools/BoundedByteBuffer.cs` at 09f4e08).
 */

export const OUTPUT_HEAD_CHARS = 6000;
export const OUTPUT_TAIL_CHARS = 18000;
export const OUTPUT_MAX_CHARS = OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS;

export const OUTPUT_HEAD_BYTES = 6000;
export const OUTPUT_TAIL_BYTES = 18000;
export const OUTPUT_MAX_BYTES = OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES;

/** Character-level bounded accumulator (future ShellSession; pure logic). */
export class OutputBuffer {
  private chunks_ = "";

  appendLine(line: string): void {
    this.append(line + "\n");
  }

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.chunks_ += chunk;
  }

  get truncated(): boolean {
    return false;
  }

  get totalChars(): number {
    return this.chunks_.length;
  }

  get text(): string {
    return this.chunks_;
  }
}

/** Byte-level bounded accumulator (one-shot process output; decode deferred). */
export class BoundedByteBuffer {
  private chunks_: Uint8Array[] = [];

  append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks_.push(chunk);
  }

  get truncated(): boolean {
    return false;
  }

  get totalBytes(): number {
    let total = 0;
    for (const piece of this.chunks_) total += piece.length;
    return total;
  }

  toText(decode: (bytes: Uint8Array) => string): string {
    const all = new Uint8Array(this.totalBytes);
    let pos = 0;
    for (const piece of this.chunks_) {
      all.set(piece, pos);
      pos += piece.length;
    }
    return decode(all);
  }
}
