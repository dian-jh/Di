/*
 * Minimal text I/O interfaces for the CLI dispatch shell. `CliApp` never
 * touches the console: input,
 * output and TTY detection are injected, so the shell is replayable in any host
 * and testable without real stdio. `StringTextWriter` / `LineTextReader` /
 * `nullTextReader` are the in-memory implementations the tests (and simple hosts)
 * use; {@link createStdinReader} is the real stdin-backed reader the CLI bin
 * entry uses.
 */

import { createInterface } from "node:readline";

export interface TextWriter {
  write(text: string): void;
  writeLine(text?: string): void;
}

export interface TextReader {
  /** Next line without the line terminator; `null` at EOF. */
  readLine(): Promise<string | null>;
}

/** In-memory text writer capturing everything written (tests / embedded hosts). */
export class StringTextWriter implements TextWriter {
  private readonly parts: string[] = [];

  write(text: string): void {
    this.parts.push(text);
  }

  writeLine(text = ""): void {
    this.parts.push(text + "\n");
  }

  /** The accumulated text. */
  text(): string {
    return this.parts.join("");
  }

  /** Drop everything captured so far. */
  clear(): void {
    this.parts.length = 0;
  }
}

/** A reader over a fixed line list (`StringReader`). */
export class LineTextReader implements TextReader {
  private readonly lines: readonly string[];
  private index = 0;

  constructor(lines: readonly string[]) {
    this.lines = lines;
  }

  async readLine(): Promise<string | null> {
    if (this.index >= this.lines.length) return null;
    const line = this.lines[this.index]!;
    this.index += 1;
    return line;
  }
}

/** A reader that is immediately at EOF (`TextReader.Null`). */
export const nullTextReader: TextReader = {
  async readLine(): Promise<string | null> {
    return null;
  },
};

/*
 * A real line reader over a Node readable stream (the CLI bin's stdin): lines are
 * buffered until read, `\r\n` / `\n` both terminate, EOF resolves `null`. The
 * returned `close` releases the readline interface so a CLI process can exit
 * naturally after a clean shutdown (RPC `shutdown` / EOF without a lingering
 * handle).
 */
export function createStdinReader(input: NodeJS.ReadableStream): TextReader & { close(): void } {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const queue: string[] = [];
  let ended = false;
  const waiters: Array<(line: string | null) => void> = [];
  rl.on("line", (line) => {
    if (waiters.length > 0) waiters.shift()!(line);
    else queue.push(line);
  });
  rl.on("close", () => {
    ended = true;
    while (waiters.length > 0) waiters.shift()!(null);
  });
  return {
    async readLine(): Promise<string | null> {
      if (queue.length > 0) return queue.shift()!;
      if (ended) return null;
      return new Promise((resolve) => waiters.push(resolve));
    },
    close(): void {
      rl.close();
    },
  };
}
