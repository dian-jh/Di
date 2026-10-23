/** Resolve a TypeScript RPC backend without spawning a shell shim. */
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Launcher } from "./client.ts";

export type BackendSource = "di-bin" | "ts-entry" | "installed-ts-entry";
export type BackendLaunchDecision =
  | { kind: "launcher"; launcher: Launcher }
  | { kind: "unavailable"; missing: BackendSource[] };

const RPC_ARGS = ["--mode", "rpc"];
const packageParent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Entry in a workspace checkout. */
export function resolveTsEntryPath(): string {
  return path.join(packageParent, "packages", "coding-agent", "dist", "cli", "main.js");
}

/** Entry beside the installed di-tui package in node_modules. */
export function resolveInstalledTsEntryPath(): string {
  return path.join(packageParent, "@di", "coding-agent", "dist", "cli", "main.js");
}

export function buildBackendLauncher(
  env: NodeJS.ProcessEnv = process.env,
  existsFn: (file: string) => boolean = existsSync,
): BackendLaunchDecision {
  if (env.DI_BIN) return { kind: "launcher", launcher: { bin: env.DI_BIN, args: RPC_ARGS } };
  for (const entry of [resolveTsEntryPath(), resolveInstalledTsEntryPath()]) {
    if (existsFn(entry)) {
      return { kind: "launcher", launcher: { bin: process.execPath, args: [entry, ...RPC_ARGS] } };
    }
  }
  return { kind: "unavailable", missing: ["di-bin", "ts-entry", "installed-ts-entry"] };
}
