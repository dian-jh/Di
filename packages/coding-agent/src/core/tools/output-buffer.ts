/*
 * Bounded streaming output accumulators (* and ).
 *
 * The head (first 6000 units) and the tail (last 18000 units) are each kept
 * within budget; everything past the head that does not fit the tail is dropped
 * as it arrives, so memory stays constant for any output length. The final text
 * is head + truncation notice + tail. We never collect-then-truncate: a multi-MB
 * command output would exhaust memory before the trim.
 *
 * - `OutputBuffer` counts UTF-16 code units (`string.Length` semantics); this
 * is the pure-logic accumulator the future line-based ShellSession decoding
 * will use.
 * - `BoundedByteBuffer` counts raw bytes and defers decoding to the end
 * (`toText`), so a whole segment can be smart-decoded once (UTF-8 first, OEM
 * fallback). Per-chunk streaming decode would lock the encoding at the first
 * chunk and garble a stream where cmd built-ins write OEM bytes while.NET CLI
 * writes UTF-8 (see `docs/modules/tools.md`). Used
 * by the one-shot process runner.
 */

export const OUTPUT_HEAD_CHARS = 6000;
export const OUTPUT_TAIL_CHARS = 18000;
export const OUTPUT_MAX_CHARS = OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS;

export const OUTPUT_HEAD_BYTES = 6000;
export const OUTPUT_TAIL_BYTES = 18000;
export const OUTPUT_MAX_BYTES = OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES;

/** Drop old tail pieces from the front without O(n) `shift` on a hot path. */
function compactTail<T>(pieces: T[], start: number): { pieces: T[]; start: number } {
  if (start > 1024 && start * 2 > pieces.length) {
    return { pieces: pieces.slice(start), start: 0 };
  }
  return { pieces, start };
}

/*
 * Character-level bounded accumulator (head + truncation notice + tail).
 *: once the head fills it is frozen, the remainder
 * accumulates in the tail and only the last `TailChars` are kept.
 */
export class OutputBuffer {
  private head_ = "";
  private frozenHead_: string | null = null;
  private tail_: string[] = [];
  private tailStart_ = 0;
  private tailChars_ = 0;
  private totalChars_ = 0;

  /** Append a line, auto-terminating it with `\n` (`AppendLine`). */
  appendLine(line: string): void {
    this.append(line + "\n");
  }

  /** Append a raw chunk (no newline added). */
  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.totalChars_ += chunk.length;

    // Head not full: keep going until it fills, then freeze it.
    if (this.frozenHead_ === null) {
      const room = OUTPUT_HEAD_CHARS - this.head_.length;
      if (chunk.length <= room) {
        this.head_ += chunk;
        if (this.head_.length === OUTPUT_HEAD_CHARS) this.frozenHead_ = this.head_;
        return;
      }
      this.head_ += chunk.slice(0, room);
      this.frozenHead_ = this.head_;
      chunk = chunk.slice(room);
    }

    this.appendTail_(chunk);
  }

  private appendTail_(chunk: string): void {
    // A single chunk past the tail budget discards the whole old tail.
    if (chunk.length >= OUTPUT_TAIL_CHARS) {
      this.tail_ = [chunk.slice(chunk.length - OUTPUT_TAIL_CHARS)];
      this.tailStart_ = 0;
      this.tailChars_ = OUTPUT_TAIL_CHARS;
      return;
    }
    this.tail_.push(chunk);
    this.tailChars_ += chunk.length;
    while (this.tailChars_ > OUTPUT_TAIL_CHARS) {
      this.tailChars_ -= this.tail_[this.tailStart_]!.length;
      this.tailStart_ += 1;
    }
    const compacted = compactTail(this.tail_, this.tailStart_);
    this.tail_ = compacted.pieces;
    this.tailStart_ = compacted.start;
  }

  /** Whether the accumulated total exceeded the head + tail budget. */
  get truncated(): boolean {
    return this.frozenHead_ !== null && this.totalChars_ > OUTPUT_MAX_CHARS;
  }

  /** Total characters received, including the dropped middle. */
  get totalChars(): number {
    return this.totalChars_;
  }

  /** Final text: within budget -> everything; over -> head + notice + tail. */
  get text(): string {
    const tailText = this.tail_.slice(this.tailStart_).join("");
    if (this.frozenHead_ === null) return this.head_ + tailText;
    if (this.totalChars_ <= OUTPUT_MAX_CHARS) return this.frozenHead_ + tailText;
    const dropped = this.totalChars_ - (this.frozenHead_.length + tailText.length);
    return this.frozenHead_ + `\n…[输出过长，已截断中间 ${dropped} 字符]…\n` + tailText;
  }
}

/**
 * Byte-level bounded accumulator (head + truncation notice + tail over raw
 * bytes). Mirrors `BoundedByteBuffer.cs`: decode is deferred to `toText` so the
 * caller can smart-decode each segment once.
 */
export class BoundedByteBuffer {
  private head_ = new Uint8Array(OUTPUT_HEAD_BYTES);
  private headCount_ = 0;
  private headFrozen_ = false;
  private tail_: Uint8Array[] = [];
  private tailStart_ = 0;
  private tailBytes_ = 0;
  private totalBytes_ = 0;

  /** Append a raw byte chunk (a drained pipe chunk). */
  append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.totalBytes_ += chunk.length;

    if (!this.headFrozen_) {
      const room = OUTPUT_HEAD_BYTES - this.headCount_;
      if (chunk.length <= room) {
        this.head_.set(chunk, this.headCount_);
        this.headCount_ += chunk.length;
        if (this.headCount_ === OUTPUT_HEAD_BYTES) this.headFrozen_ = true;
        return;
      }
      this.head_.set(chunk.subarray(0, room), this.headCount_);
      this.headCount_ = OUTPUT_HEAD_BYTES;
      this.headFrozen_ = true;
      this.appendTail_(chunk.subarray(room));
      return;
    }
    this.appendTail_(chunk);
  }

  private appendTail_(chunk: Uint8Array): void {
    if (chunk.length >= OUTPUT_TAIL_BYTES) {
      this.tail_ = [chunk.subarray(chunk.length - OUTPUT_TAIL_BYTES)];
      this.tailStart_ = 0;
      this.tailBytes_ = OUTPUT_TAIL_BYTES;
      return;
    }
    this.tail_.push(chunk);
    this.tailBytes_ += chunk.length;
    while (this.tailBytes_ > OUTPUT_TAIL_BYTES) {
      this.tailBytes_ -= this.tail_[this.tailStart_]!.length;
      this.tailStart_ += 1;
    }
    const compacted = compactTail(this.tail_, this.tailStart_);
    this.tail_ = compacted.pieces;
    this.tailStart_ = compacted.start;
  }

  /** Whether the accumulated total exceeded the head + tail budget. */
  get truncated(): boolean {
    return this.headFrozen_ && this.totalBytes_ > OUTPUT_MAX_BYTES;
  }

  /** Total bytes received, including the dropped middle. */
  get totalBytes(): number {
    return this.totalBytes_;
  }

  /**
   * Decode to text. Within budget the head+tail are one contiguous byte stream
   * decoded as a whole (so a multi-byte character never straddles a seam);
   * over budget the head and tail are decoded separately with the truncation
   * notice between them (the decoder's seam trimming drops at most one
   * character at the junction).
   */
  toText(decode: (bytes: Uint8Array) => string): string {
    const head = this.head_.subarray(0, this.headCount_);
    const tail = this.tailBytesArray_();
    if (!this.headFrozen_ || this.totalBytes_ <= OUTPUT_MAX_BYTES) {
      const all = new Uint8Array(head.length + tail.length);
      all.set(head, 0);
      all.set(tail, head.length);
      return decode(all);
    }
    const dropped = this.totalBytes_ - (this.headCount_ + this.tailBytes_);
    return decode(head) + `\n…[输出过长，已截断中间 ${dropped} 字节]…\n` + decode(tail);
  }

  private tailBytesArray_(): Uint8Array {
    const result = new Uint8Array(this.tailBytes_);
    let pos = 0;
    for (let i = this.tailStart_; i < this.tail_.length; i += 1) {
      const piece = this.tail_[i]!;
      result.set(piece, pos);
      pos += piece.length;
    }
    return result;
  }
}
