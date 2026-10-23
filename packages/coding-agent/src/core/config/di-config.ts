import { readFile } from "node:fs/promises";
import { parseJsonObject } from "./jsonc.ts";

/*
 * Layered config merge. Load:
 * default -> user (~/.di/config.json) -> project (<workspace>/.di/config.json)
 * -> environment variables, later layers override earlier ones per key.
 *
 * All sources are flattened into one key map keyed by lowercased `:`-separated
 * paths (the IConfiguration semantics: case-insensitive lookup, arrays indexed).
 * This makes the nested-object merge deep by construction — not a shallow spread.
 *
 * Ownership: only reads files, never creates or overwrites them
 * (docs/di-home.md §4: config files are user-owned, program read-only).
 */

/** A single effective config value after merging (JSON value types preserved). */
export type ConfigValue = string | number | boolean | null;

/** The four layered config sources (priority low -> high). */
export interface DiConfigSources {
  /** Built-in defaults (mirror of the shipped appsettings.json ). */
  readonly defaults: Readonly<Record<string, unknown>>;
  /** User-global config file (~/.di/config.json); undefined disables the layer. */
  readonly userConfigPath: string | undefined;
  /** Project config file (<workspace>/.di/config.json); undefined disables the layer. */
  readonly projectConfigPath: string | undefined;
  /** Process environment snapshot. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** IO seam for config loading (explicit injection, no hidden global reads). */
export interface DiConfigDeps {
  /** Read a UTF-8 text file; resolve undefined when it does not exist (all sources optional). */
  readonly readFile: (path: string) => Promise<string | undefined>;
}

const KEY_DELIMITER = ":";

/** Factory defaults shipped with the program (current implementation ). */
export const DEFAULT_CONFIG: Readonly<Record<string, unknown>> = {
  DeepSeek: {
    DefaultReasoningEffort: "high",
    StrictTools: false,
    UseSystemProxy: false,
  },
};

function normalizeKey(path: string): string {
  return path.toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flatten a JSON value into `:`-separated, case-insensitive keys (arrays indexed like.NET). */
function flattenValue(value: unknown, prefix: string, out: Map<string, ConfigValue>): void {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenValue(child, prefix.length === 0 ? key : `${prefix}${KEY_DELIMITER}${key}`, out);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      flattenValue(value[index], `${prefix}${KEY_DELIMITER}${index}`, out);
    }
    return;
  }
  const configValue = toConfigValue(value);
  if (configValue !== undefined) {
    out.set(normalizeKey(prefix), configValue);
  }
}

function toConfigValue(value: unknown): ConfigValue | undefined {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "object":
      return value === null ? null : undefined;
    default:
      return undefined;
  }
}

/**
 * Env var layer: `__` is the section delimiter (`.NET AddEnvironmentVariables()`),
 * a single `_` is literal. Values are always strings (process env semantics).
 */
function flattenEnv(env: Readonly<Record<string, string | undefined>>, out: Map<string, ConfigValue>): void {
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    const key = name.replace(/__/g, KEY_DELIMITER);
    out.set(normalizeKey(key), value);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}

/** Read a file as UTF-8; resolve undefined on ENOENT. */
export async function defaultReadFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

/** The merged layered config. */
export class DiConfig {
  private readonly flat: ReadonlyMap<string, ConfigValue>;

  private constructor(flat: ReadonlyMap<string, ConfigValue>) {
    this.flat = flat;
  }

  /** Case-insensitive lookup. Returns undefined for a missing key, null for a present JSON null. */
  get(path: string): ConfigValue | undefined {
    return this.flat.get(normalizeKey(path));
  }

  /** True when the key exists, even when its value is null. */
  has(path: string): boolean {
    return this.flat.has(normalizeKey(path));
  }

  /**
   * Pure merge of the four layers. `user` and `project` are the parsed JSONC objects
   * (undefined when the source file is missing). Later layers override earlier ones
   * per key; nesting is preserved (deep, not shallow spread).
   */
  static merge(
    defaults: Readonly<Record<string, unknown>>,
    user: Readonly<Record<string, unknown>> | undefined,
    project: Readonly<Record<string, unknown>> | undefined,
    env: Readonly<Record<string, string | undefined>>,
  ): DiConfig {
    const flat = new Map<string, ConfigValue>();
    flattenValue(defaults, "", flat);
    if (user !== undefined) {
      flattenValue(user, "", flat);
    }
    if (project !== undefined) {
      flattenValue(project, "", flat);
    }
    flattenEnv(env, flat);
    return new DiConfig(flat);
  }

  /** Load and merge the four layers from disk. Files are optional; missing ones are skipped. */
  static async load(sources: DiConfigSources, deps: DiConfigDeps): Promise<DiConfig> {
    const user =
      sources.userConfigPath === undefined
        ? undefined
        : await readOptionalConfig(sources.userConfigPath, deps);
    const project =
      sources.projectConfigPath === undefined
        ? undefined
        : await readOptionalConfig(sources.projectConfigPath, deps);
    return DiConfig.merge(sources.defaults, user, project, sources.env);
  }
}

async function readOptionalConfig(
  path: string,
  deps: DiConfigDeps,
): Promise<Record<string, unknown> | undefined> {
  const text = await deps.readFile(path);
  return text === undefined ? undefined : parseJsonObject(text, path);
}
