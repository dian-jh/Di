import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * P9-release-install-rollback — the production bin/entry contract
 * (architecture.md §7 / §141-147): the CLI MUST ship as `di-ts` →
 * `packages/coding-agent/dist/cli/main.js` so the TS command never shadows or
 * overwrites the installed system `di` (C# stays the default until migration
 * completion; validation-and-release.md §120-128).
 *
 * The pre-fix state was the known P7a divergence: package.json mapped
 * `"di": "./dist/cli/index.js"` and dist/cli/main.js did not exist. The fix
 * (cb15387) renames the entry to di-ts -> dist/cli/main.js.
 */

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
};

test("bin contract: the CLI bin is di-ts → ./dist/cli/main.js (never plain `di`)", () => {
  assert.ok(packageJson.bin, "package.json must declare a bin map");
  assert.equal(
    packageJson.bin["di-ts"],
    "./dist/cli/main.js",
    "di-ts must map to the production CLI entry dist/cli/main.js",
  );
  assert.equal(
    packageJson.bin["di"],
    undefined,
    "the TS command must NOT occupy the plain `di` bin name (C# keeps the system `di`)",
  );
});

test("bin contract: exports[\"./cli\"] maps types/import to dist/cli/main.js", () => {
  const cliExport = packageJson.exports?.["./cli"] as { types?: string; import?: string } | undefined;
  assert.ok(cliExport, 'package.json exports["./cli"] must exist (architecture §144)');
  assert.equal(cliExport.types, "./dist/cli/main.d.ts");
  assert.equal(cliExport.import, "./dist/cli/main.js");
});

test("bin contract: the compiled production entry dist/cli/main.js exists after build", () => {
  const entry = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
  assert.ok(existsSync(entry), `dist/cli/main.js must be emitted by the build: ${entry}`);
});

test("bin contract: the entry is a runnable node script with the unix shebang", () => {
  const entry = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
  const head = readFileSync(entry, "utf8").split("\n", 1)[0] ?? "";
  assert.ok(
    head.startsWith("#!/usr/bin/env node"),
    "the CLI entry must carry the node shebang so npm/OS bin shims can execute it",
  );
});
