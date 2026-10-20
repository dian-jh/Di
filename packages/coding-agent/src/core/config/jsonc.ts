import { parse, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";

/**
 * JSONC parsing for config files.
 *
 * Config sources (user `config.json`, project `.di/config.json`, and the shipped
 * defaults) follow the C# baseline, where files are parsed with .NET's
 * JsonConfigurationProvider, which tolerates comments and trailing commas. A pinned
 * JSONC parser (`jsonc-parser` 3.3.1, MIT) is used instead of a regex comment
 * stripper or strict JSON.parse — see operator-guide's new-dependency rule.
 */

/** Raised when a config source cannot be parsed as a JSONC object. */
export class ConfigParseError extends Error {
  readonly source: string;
  readonly errors: readonly ParseError[];

  constructor(source: string, errors: readonly ParseError[], message: string) {
    super(message);
    this.name = "ConfigParseError";
    this.source = source;
    this.errors = errors;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a JSONC text into an unknown value; throws ConfigParseError on syntax errors. */
export function parseJsonc(text: string, source: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0];
    if (first === undefined) {
      throw new ConfigParseError(source, errors, `${source}: invalid JSONC`);
    }
    throw new ConfigParseError(
      source,
      errors,
      `${source}: invalid JSONC at offset ${first.offset} (${printParseErrorCode(first.error)})`,
    );
  }
  return value;
}

/** Parse a JSONC text whose root must be an object (like .NET config files). */
export function parseJsonObject(text: string, source: string): Record<string, unknown> {
  const value = parseJsonc(text, source);
  if (!isPlainObject(value)) {
    throw new ConfigParseError(source, [], `${source}: root element must be a JSON object`);
  }
  return value;
}
