import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildBackendLauncher, resolveTsEntryPath } from "../src/rpc/backend-launcher.ts";

const entry = resolveTsEntryPath();
const installedEntry = path.resolve(path.dirname(entry), "../../../../@di/coding-agent/dist/cli/main.js");
const only = (...files: string[]) => (file: string) => files.includes(file);

describe("TypeScript backend discovery", () => {
  it("launches the workspace entry with Node", () => {
    assert.deepEqual(buildBackendLauncher({}, only(entry)), {
      kind: "launcher", launcher: { bin: process.execPath, args: [entry, "--mode", "rpc"] },
    });
  });

  it("resolves the installed package entry when the workspace entry is absent", () => {
    assert.deepEqual(buildBackendLauncher({}, only(installedEntry)), {
      kind: "launcher", launcher: { bin: process.execPath, args: [installedEntry, "--mode", "rpc"] },
    });
  });

  it("honors the explicit DI_BIN override", () => {
    assert.deepEqual(buildBackendLauncher({ DI_BIN: process.execPath }, only(entry)), {
      kind: "launcher", launcher: { bin: process.execPath, args: ["--mode", "rpc"] },
    });
  });

  it("does not discover an unrelated di executable on PATH", () => {
    const directory = path.resolve("external-bin");
    const decision = buildBackendLauncher({ PATH: directory }, only(path.join(directory, "di")));
    assert.equal(decision.kind, "unavailable");
  });

  it("reports missing TypeScript entries without trying a user binary", () => {
    const decision = buildBackendLauncher({ HOME: path.resolve("home"), USERPROFILE: path.resolve("home") }, () => false);
    assert.deepEqual(decision, { kind: "unavailable", missing: ["di-bin", "ts-entry", "installed-ts-entry"] });
  });
});
