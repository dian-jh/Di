import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const installerPath = fileURLToPath(new URL("../../../../install.cmd", import.meta.url));
const installer = readFileSync(installerPath, "ascii");

test("Windows installer delegates to install.ps1 and passes through its exit code", () => {
  assert.match(installer, /^powershell\.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\.ps1" %\*/m);
  assert.match(installer, /exit \/b %ERRORLEVEL%/i);
  assert.doesNotMatch(installer, /dotnet|Di\.Cli|tui/i);
});