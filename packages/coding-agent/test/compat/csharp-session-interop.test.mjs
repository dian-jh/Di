import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const harness = resolve(here, "csharp-session-harness/Program.cs");

test("C# reference harness exists for bidirectional session interoperability", () => {
  assert.ok(existsSync(harness), `missing C# reference harness: ${harness}`);
  const runner = resolve(here, "csharp-session-interop.mjs");
  const result = spawnSync(process.execPath, [runner], { encoding: "utf8", cwd: resolve(here, "../../../..") });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /C# writer -> TypeScript reader: PASS/);
  assert.match(result.stdout, /TypeScript writer -> C# SessionLog\.LoadRecovery: PASS/);
});
