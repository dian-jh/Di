import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
};

test("npm package exposes the explicit di-ts alias; installer owns global di", () => {
  assert.ok(packageJson.bin, "package.json must declare a bin map");
  assert.equal(packageJson.bin["di-ts"], "./dist/cli/main.js");
  assert.equal(packageJson.bin["di"], undefined, "install.ps1 provides the global di launcher");
});

test("CLI export maps types/import to dist/cli/main.js", () => {
  const cliExport = packageJson.exports?.["./cli"] as { types?: string; import?: string } | undefined;
  assert.ok(cliExport, 'package.json exports["./cli"] must exist');
  assert.equal(cliExport.types, "./dist/cli/main.d.ts");
  assert.equal(cliExport.import, "./dist/cli/main.js");
});

test("compiled production entry exists after build", () => {
  const entry = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
  assert.ok(existsSync(entry), `dist/cli/main.js must be emitted by the build: ${entry}`);
});

test("compiled entry is a runnable node script with the unix shebang", () => {
  const entry = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
  const head = readFileSync(entry, "utf8").split("\n", 1)[0] ?? "";
  assert.ok(head.startsWith("#!/usr/bin/env node"));
});