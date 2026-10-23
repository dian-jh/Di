/*
 * Argument parsing/validation shared by the tools.
 *
 * (TryGetString / TryGetContent /
 * TryGetOptionalInt) so the error observations match the.
 */

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** Parse raw model JSON arguments into a plain object; generic JSON errors stay observations. */
export function parseArguments(argumentsJson: string): ParseResult<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson);
  } catch {
    return { ok: false, error: "error: arguments 不是合法 JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "error: arguments 必须是 JSON 对象" };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** Required string; missing / non-string / blank is an error (TryGetString). */
export function getRequiredString(
  args: Readonly<Record<string, unknown>>,
  name: string,
): ParseResult<string> {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: `error: 缺少 string 参数 '${name}'` };
  }
  return { ok: true, value };
}

/** String that may be empty/whitespace (file content); missing/non-string is an error. */
export function getContent(
  args: Readonly<Record<string, unknown>>,
  name: string,
): ParseResult<string> {
  const value = args[name];
  if (typeof value !== "string") {
    return { ok: false, error: `error: 缺少 string 参数 '${name}'` };
  }
  return { ok: true, value };
}

/** Optional integer; absent is fine, present-but-invalid is an error (TryGetOptionalInt). */
export function getOptionalInt(
  args: Readonly<Record<string, unknown>>,
  name: string,
): ParseResult<number | undefined> {
  if (!(name in args)) {
    return { ok: true, value: undefined };
  }
  const value = args[name];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, error: `error: 参数 '${name}' 必须是整数` };
  }
  return { ok: true, value };
}

/** Optional boolean; absent is fine, present-but-invalid is an error (TryGetOptionalBool). */
export function getOptionalBool(
  args: Readonly<Record<string, unknown>>,
  name: string,
): ParseResult<boolean | undefined> {
  if (!(name in args)) {
    return { ok: true, value: undefined };
  }
  const value = args[name];
  if (typeof value !== "boolean") {
    return { ok: false, error: `error: 参数 '${name}' 必须是布尔值` };
  }
  return { ok: true, value };
}

/** Build the JSON-Schema `parameters` object for a tool definition. */
export function toolSchema(
  required: readonly (readonly [name: string, type: string, description: string])[],
  optional: readonly (readonly [name: string, type: string, description: string])[] = [],
): Readonly<Record<string, unknown>> {
  const properties: Record<string, unknown> = {};
  for (const [name, type, description] of required) {
    properties[name] = { type, description };
  }
  for (const [name, type, description] of optional) {
    properties[name] = { type, description };
  }
  return {
    type: "object",
    properties,
    required: required.map(([name]) => name),
  };
}
