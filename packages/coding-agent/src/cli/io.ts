/**
 * Minimal text I/O seams for the CLI dispatch shell (C# `TextReader` / `TextWriter`
 * counterparts at baseline 09f4e08). `CliApp` never touches the console: input,
 * output and TTY detection are injected, so the shell is replayable in any host
 * and testable without real stdio. `StringTextWriter` / `LineTextReader` /
 * `nullTextReader` are the in-memory implementations the tests (and simple hosts)
 * use.
 */

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

/** A reader over a fixed line list (mirrors C# `StringReader`). */
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

/** A reader that is immediately at EOF (C# `TextReader.Null`). */
export const nullTextReader: TextReader = {
  async readLine(): Promise<string | null> {
    return null;
  },
};
