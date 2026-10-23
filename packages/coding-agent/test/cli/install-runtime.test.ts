import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const installer = join(repoRoot, "install.ps1");

function createInstallerFixture(root: string, entrySource = 'console.log("fixture TypeScript CLI");\n'): string {
  const fixtureInstaller = join(root, "install.ps1");
  mkdirSync(join(root, "packages", "coding-agent", "dist", "cli"), { recursive: true });
  writeFileSync(fixtureInstaller, readFileSync(installer));
  writeFileSync(join(root, "packages", "coding-agent", "package.json"), JSON.stringify({ name: "@di/coding-agent", type: "module" }));
  writeFileSync(join(root, "packages", "coding-agent", "dist", "cli", "main.js"), entrySource);
  for (const pkg of ["ai", "agent"]) {
    mkdirSync(join(root, "packages", pkg), { recursive: true });
    mkdirSync(join(root, "packages", pkg, "dist"), { recursive: true });
    writeFileSync(join(root, "packages", pkg, "package.json"), JSON.stringify({ type: "module" }));
  }
  mkdirSync(join(root, "packages", "coding-agent", "test", "compat", "csharp-session-harness", "bin"), { recursive: true });
  mkdirSync(join(root, "packages", "coding-agent", "test", "compat", "csharp-session-harness", "obj"), { recursive: true });
  writeFileSync(join(root, "packages", "coding-agent", "test", "compat", "csharp-session-harness", "bin", "legacy.dll"), "ignored old build artifact");
  writeFileSync(join(root, "packages", "coding-agent", "test", "compat", "csharp-session-harness", "obj", "legacy.cache"), "ignored old build artifact");
  mkdirSync(join(root, "tui"), { recursive: true });
  mkdirSync(join(root, "tui", "dist"), { recursive: true });
  writeFileSync(join(root, "tui", "package.json"), JSON.stringify({ type: "module" }));
  const dependencies = ["jsonc-parser", "marked", "get-east-asian-width", "iconv-lite", "safer-buffer", "koffi", "undici"];
  for (const name of dependencies) {
    const packageDir = join(root, "node_modules", name);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name, type: "module" }));
  }
  const piTui = join(root, "node_modules", "@earendil-works", "pi-tui");
  mkdirSync(piTui, { recursive: true });
  writeFileSync(join(piTui, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", type: "module" }));
  return join(root, "packages", "coding-agent", "dist", "cli", "main.js");
}

function runFixtureInstaller(fixtureRoot: string, diHome: string) {
  const shell = process.env.DI_TEST_POWERSHELL ?? (process.platform === "win32" ? "powershell.exe" : "pwsh");
  const shellArgs = process.platform === "win32" && process.env.DI_TEST_POWERSHELL === undefined
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass"] : ["-NoProfile"];
  return spawnSync(shell, [...shellArgs, "-File", join(fixtureRoot, "install.ps1"), "-DiHome", diHome,
    "-SkipBuild", ...(process.platform === "win32" ? ["-SkipPathUpdate"] : [])],
  { cwd: fixtureRoot, encoding: "utf8", windowsHide: true, timeout: 30_000 });
}

function installerArgs(tempRoot: string, name: string): { tempRoot: string; fixtureRoot: string; diHome: string; cleanup: () => void } {
  const fixtureRoot = join(tempRoot, "repo");
  const diHome = join(tempRoot, name);
  mkdirSync(fixtureRoot, { recursive: true });
  return { tempRoot, fixtureRoot, diHome, cleanup: () => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) };
}

test("failed first install leaves no partial runtime or launchers", { skip: process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin" }, (t) => {
  const paths = installerArgs(mkdtempSync(join(tmpdir(), "di-install-first-failure-")), "di-home");
  const entry = createInstallerFixture(paths.fixtureRoot, 'console.error("fixture smoke failure"); process.exit(23);\n');
  t.after(paths.cleanup);

  const result = runFixtureInstaller(paths.fixtureRoot, paths.diHome);
  assert.equal(result.error, undefined, `PowerShell installer could not start: ${result.error?.message ?? ""}`);
  assert.notEqual(result.status, 0, "the staged CLI smoke failure must abort installation");
  assert.equal(existsSync(join(paths.diHome, "ts-cli")), false, "failed first install must not leave a partial runtime");
  assert.equal(existsSync(join(paths.diHome, "bin", process.platform === "win32" ? "di-ts.cmd" : "di-ts")), false,
    "failed first install must not leave a usable launcher");
  assert.deepEqual(readdirSync(paths.diHome).filter((name) => name.startsWith("ts-cli.stage-")), [], "failed first stage must be removed");
  assert.ok(existsSync(entry), "fixture source remains available for diagnostics");
});

test("failed reinstall preserves the previous runtime and launchers", { skip: process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin" }, (t) => {
  const paths = installerArgs(mkdtempSync(join(tmpdir(), "di-install-reinstall-failure-")), "di-home");
  const entry = createInstallerFixture(paths.fixtureRoot);
  t.after(paths.cleanup);

  const first = runFixtureInstaller(paths.fixtureRoot, paths.diHome);
  assert.equal(first.error, undefined, `initial installer could not start: ${first.error?.message ?? ""}`);
  assert.equal(first.status, 0, `initial fixture install failed\n${first.stdout}\n${first.stderr}`);
  const installedEntry = join(paths.diHome, "ts-cli", "node_modules", "@di", "coding-agent", "dist", "cli", "main.js");
  const launcher = join(paths.diHome, "bin", process.platform === "win32" ? "di-ts.cmd" : "di-ts");
  const beforeRuntime = readFileSync(installedEntry);
  const beforeLauncher = readFileSync(launcher);

  writeFileSync(entry, 'console.error("fixture smoke failure"); process.exit(23);\n');
  const second = runFixtureInstaller(paths.fixtureRoot, paths.diHome);
  assert.equal(second.error, undefined, `reinstaller could not start: ${second.error?.message ?? ""}`);
  assert.notEqual(second.status, 0, "a bad staged CLI must fail before replacing the working installation");
  assert.deepEqual(readFileSync(installedEntry), beforeRuntime, "previous runtime must be restored byte-for-byte");
  assert.deepEqual(readFileSync(launcher), beforeLauncher, "previous launcher must be preserved byte-for-byte");
  assert.deepEqual(readdirSync(paths.diHome).filter((name) => name.startsWith("ts-cli.stage-")), [], "failed stage must be cleaned up");
});

test("missing runtime dependency on reinstall preserves the working installation", { skip: process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin" }, (t) => {
  const paths = installerArgs(mkdtempSync(join(tmpdir(), "di-install-dependency-failure-")), "di-home");
  createInstallerFixture(paths.fixtureRoot);
  t.after(paths.cleanup);
  const first = runFixtureInstaller(paths.fixtureRoot, paths.diHome);
  assert.equal(first.status, 0, `initial fixture install failed\n${first.stdout}\n${first.stderr}`);
  const installedEntry = join(paths.diHome, "ts-cli", "node_modules", "@di", "coding-agent", "dist", "cli", "main.js");
  const launcher = join(paths.diHome, "bin", process.platform === "win32" ? "di-ts.cmd" : "di-ts");
  const beforeRuntime = readFileSync(installedEntry);
  const beforeLauncher = readFileSync(launcher);

  rmSync(join(paths.fixtureRoot, "node_modules", "marked"), { recursive: true, force: true });
  const second = runFixtureInstaller(paths.fixtureRoot, paths.diHome);
  assert.notEqual(second.status, 0, "missing dependency must abort staging");
  assert.deepEqual(readFileSync(installedEntry), beforeRuntime, "copy failure must preserve old runtime");
  assert.deepEqual(readFileSync(launcher), beforeLauncher, "copy failure must preserve old launcher");
  assert.deepEqual(readdirSync(paths.diHome).filter((name) => name.startsWith("ts-cli.stage-")), [], "failed stage must be cleaned up");
});

test("launcher switch failure restores the previous runtime and both shims", { skip: process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin" }, (t) => {
  const paths = installerArgs(mkdtempSync(join(tmpdir(), "di-install-switch-failure-")), "di-home");
  createInstallerFixture(paths.fixtureRoot);
  t.after(paths.cleanup);
  const first = runFixtureInstaller(paths.fixtureRoot, paths.diHome);
  assert.equal(first.status, 0, `initial fixture install failed\n${first.stdout}\n${first.stderr}`);
  const currentEntry = join(paths.diHome, "ts-cli", "node_modules", "@di", "coding-agent", "dist", "cli", "main.js");
  const tsShim = join(paths.diHome, "bin", process.platform === "win32" ? "di-ts.cmd" : "di-ts");
  const defaultShim = join(paths.diHome, "bin", process.platform === "win32" ? "di.cmd" : "di");
  const snapshots = [readFileSync(currentEntry), readFileSync(tsShim), readFileSync(defaultShim)];

  const fixtureInstaller = join(paths.fixtureRoot, "install.ps1");
  const originalScript = readFileSync(fixtureInstaller, "utf8");
  const injection = [
    "function Move-Item {",
    "  param([string]$LiteralPath, [string]$Destination, [switch]$Force)",
    "  if ($LiteralPath -eq $stageDefaultShim) { Write-Output 'DI_INSTALL_FAILPOINT'; throw 'injected launcher publish failure' }",
    "  Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force",
    "}",
    "",
  ].join("\n");
  writeFileSync(fixtureInstaller, originalScript.replace('$ErrorActionPreference = "Stop"', () => `$ErrorActionPreference = "Stop"\n${injection}`));

  const second = runFixtureInstaller(paths.fixtureRoot, paths.diHome);
  assert.notEqual(second.status, 0, "injected failure publishing the default shim must abort install");
  assert.ok(second.stdout.split(/\r?\n/).includes("DI_INSTALL_FAILPOINT"), "fixture must reach the launcher publish failpoint");
  assert.match(`${second.stdout}\n${second.stderr}`, /injected launcher publish failure/);
  assert.deepEqual(readFileSync(currentEntry), snapshots[0], "runtime must be restored after launcher publish failure");
  assert.deepEqual(readFileSync(tsShim), snapshots[1], "di-ts shim must be restored byte-for-byte");
  assert.deepEqual(readFileSync(defaultShim), snapshots[2], "di shim must be restored byte-for-byte");
});

test("simulated PATH persistence failure rolls back runtime and shims without touching user PATH", { skip: process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin" }, (t) => {
  const paths = installerArgs(mkdtempSync(join(tmpdir(), "di-install-path-failure-")), "di-home");
  createInstallerFixture(paths.fixtureRoot);
  t.after(paths.cleanup);
  const first = runFixtureInstaller(paths.fixtureRoot, paths.diHome);
  assert.equal(first.status, 0, `initial fixture install failed\n${first.stdout}\n${first.stderr}`);
  const currentEntry = join(paths.diHome, "ts-cli", "node_modules", "@di", "coding-agent", "dist", "cli", "main.js");
  const tsShim = join(paths.diHome, "bin", process.platform === "win32" ? "di-ts.cmd" : "di-ts");
  const defaultShim = join(paths.diHome, "bin", process.platform === "win32" ? "di.cmd" : "di");
  const snapshots = [readFileSync(currentEntry), readFileSync(tsShim), readFileSync(defaultShim)];
  const fixtureInstaller = join(paths.fixtureRoot, "install.ps1");
  let script = readFileSync(fixtureInstaller, "utf8");
  script = script.replace('$PlatformIsWindows -and -not $SkipPathUpdate -and $pathAfter -ne $pathBefore', () => "$true");
  script = script.replace('[Environment]::SetEnvironmentVariable("Path", $pathAfter, "User")', () => "throw 'injected PATH persistence failure'");
  script = script.replace('[Environment]::SetEnvironmentVariable("Path", $pathBefore, "User")', () => "$null = $pathBefore");
  writeFileSync(fixtureInstaller, script);

  const result = runFixtureInstaller(paths.fixtureRoot, paths.diHome);
  assert.notEqual(result.status, 0, "injected PATH persistence failure must abort install");
  assert.match(`${result.stdout}\n${result.stderr}`, /injected PATH persistence failure/);
  assert.deepEqual(readFileSync(currentEntry), snapshots[0], "runtime must be restored after PATH failure");
  assert.deepEqual(readFileSync(tsShim), snapshots[1], "di-ts shim must be restored byte-for-byte");
  assert.deepEqual(readFileSync(defaultShim), snapshots[2], "di shim must be restored byte-for-byte");
});

test("transaction move helper refuses an existing destination without nesting the backup", { skip: process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin" }, (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "di-install-move-guard-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const scriptSource = readFileSync(installer, "utf8");
  const helper = scriptSource.match(/function Move-PathToAbsentDestination\([\s\S]*?\n}/)?.[0];
  assert.ok(helper, "installer must define its guarded move helper");
  const source = join(tempRoot, "ts-cli.backup");
  const destination = join(tempRoot, "ts-cli");
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(join(source, "previous.txt"), "previous runtime");
  writeFileSync(join(destination, "current.txt"), "new runtime");
  const psQuote = (value: string) => value.replaceAll("'", "''");
  const helperScript = join(tempRoot, "move-guard.ps1");
  writeFileSync(helperScript, [helper,
    `Move-PathToAbsentDestination '${psQuote(source)}' '${psQuote(destination)}'`,
  ].join("\n"));
  const shell = process.env.DI_TEST_POWERSHELL ?? (process.platform === "win32" ? "powershell.exe" : "pwsh");
  const shellArgs = process.platform === "win32" && process.env.DI_TEST_POWERSHELL === undefined
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass"] : ["-NoProfile"];
  const result = spawnSync(shell, [...shellArgs, "-File", helperScript], { cwd: tempRoot, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(result.error, undefined, `PowerShell helper fixture could not start: ${result.error?.message ?? ""}`);
  assert.notEqual(result.status, 0, "move must fail when its destination already exists");
  assert.match(`${result.stdout}\n${result.stderr}`, /destination already exists/i);
  assert.equal(readFileSync(join(source, "previous.txt"), "utf8"), "previous runtime", "backup source must remain in place");
  assert.equal(readFileSync(join(destination, "current.txt"), "utf8"), "new runtime");
  assert.equal(existsSync(join(destination, "ts-cli.backup")), false, "backup must not be nested in the destination");
});

test("successful upgrade retains the previous runtime as a runnable version", { skip: process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin" }, (t) => {
  const paths = installerArgs(mkdtempSync(join(tmpdir(), "di-install-previous-")), "di-home");
  const entry = createInstallerFixture(paths.fixtureRoot, 'console.log("fixture version one");\n');
  t.after(paths.cleanup);
  const first = runFixtureInstaller(paths.fixtureRoot, paths.diHome);
  assert.equal(first.status, 0, `initial fixture install failed\n${first.stdout}\n${first.stderr}`);

  writeFileSync(entry, 'console.log("fixture version two");\n');
  const second = runFixtureInstaller(paths.fixtureRoot, paths.diHome);
  assert.equal(second.status, 0, `fixture upgrade failed\n${second.stdout}\n${second.stderr}`);
  const currentEntry = join(paths.diHome, "ts-cli", "node_modules", "@di", "coding-agent", "dist", "cli", "main.js");
  const previousEntry = join(paths.diHome, "ts-cli.previous", "node_modules", "@di", "coding-agent", "dist", "cli", "main.js");
  assert.match(readFileSync(currentEntry, "utf8"), /version two/);
  assert.match(readFileSync(previousEntry, "utf8"), /version one/);
  const previous = spawnSync(process.execPath, [previousEntry, "--info"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(previous.status, 0, `previous CLI must remain runnable\n${previous.stderr}`);
  assert.match(previous.stdout, /version one/);
});

test("unmanaged di launcher is rejected before replacing the runtime", { skip: process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin" }, (t) => {
  const paths = installerArgs(mkdtempSync(join(tmpdir(), "di-install-unmanaged-")), "di-home");
  createInstallerFixture(paths.fixtureRoot);
  const bin = join(paths.diHome, "bin");
  mkdirSync(bin, { recursive: true });
  const blocker = join(bin, process.platform === "win32" ? "di.cmd" : "di");
  writeFileSync(blocker, "user-owned launcher");
  t.after(paths.cleanup);

  const result = runFixtureInstaller(paths.fixtureRoot, paths.diHome);
  assert.equal(result.error, undefined, `PowerShell installer could not start: ${result.error?.message ?? ""}`);
  assert.notEqual(result.status, 0, "installer must reject an unmanaged global di shim");
  assert.equal(readFileSync(blocker, "utf8"), "user-owned launcher", "unmanaged launcher must remain untouched");
  assert.equal(existsSync(join(paths.diHome, "ts-cli")), false, "the refusal must occur before installing the runtime");
});

test("runtime package copies exclude ignored source and build artifacts", { skip: process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin" }, (t) => {
  const paths = installerArgs(mkdtempSync(join(tmpdir(), "di-install-package-scope-")), "di-home");
  createInstallerFixture(paths.fixtureRoot);
  t.after(paths.cleanup);

  const result = runFixtureInstaller(paths.fixtureRoot, paths.diHome);
  assert.equal(result.error, undefined, `PowerShell installer could not start: ${result.error?.message ?? ""}`);
  assert.equal(result.status, 0, `fixture install failed\n${result.stdout}\n${result.stderr}`);
  const installedPackage = join(paths.diHome, "ts-cli", "node_modules", "@di", "coding-agent");
  assert.ok(existsSync(join(installedPackage, "package.json")), "runtime package metadata must be included");
  assert.ok(existsSync(join(installedPackage, "dist", "cli", "main.js")), "compiled CLI runtime must be included");
  assert.equal(existsSync(join(installedPackage, "test")), false, "test fixtures must not be copied into the runtime");
  assert.equal(existsSync(join(installedPackage, "test", "compat", "csharp-session-harness", "bin", "legacy.dll")), false,
    "ignored legacy build artifacts must not be propagated into the runtime");
});

test("installer refuses a concurrent install holding the DiHome lock", { skip: process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin" }, (t) => {
  const paths = installerArgs(mkdtempSync(join(tmpdir(), "di-install-lock-")), "di-home");
  createInstallerFixture(paths.fixtureRoot);
  mkdirSync(paths.diHome, { recursive: true });
  t.after(paths.cleanup);
  const quote = (value: string) => value.replaceAll("'", "''");
  const wrapper = join(paths.tempRoot, "hold-lock.ps1");
  writeFileSync(wrapper, [
    `$lock = [IO.File]::Open('${quote(join(paths.diHome, ".di-install.lock"))}', [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)`,
    "try {",
    `  & '${quote(join(paths.fixtureRoot, "install.ps1"))}' -DiHome '${quote(paths.diHome)}' -SkipBuild -SkipPathUpdate`,
    "  exit $LASTEXITCODE",
    "} finally { $lock.Dispose() }",
  ].join("\n"));
  const shell = process.env.DI_TEST_POWERSHELL ?? (process.platform === "win32" ? "powershell.exe" : "pwsh");
  const shellArgs = process.platform === "win32" && process.env.DI_TEST_POWERSHELL === undefined
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass"] : ["-NoProfile"];
  const result = spawnSync(shell, [...shellArgs, "-File", wrapper], { cwd: paths.fixtureRoot, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  assert.equal(result.error, undefined, `PowerShell lock fixture could not start: ${result.error?.message ?? ""}`);
  assert.notEqual(result.status, 0, "a second installer must reject the held exclusive lock");
  assert.match(`${result.stdout}\n${result.stderr}`, /Another installation is using/i);
  assert.equal(existsSync(join(paths.diHome, "ts-cli")), false, "lock refusal must happen before runtime changes");
});

test("Windows installer refuses a di.exe that would shadow the global di shim", { skip: process.platform !== "win32" }, (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "di-install-shadow-"));
  const diHome = join(tempRoot, "di-home");
  const bin = join(diHome, "bin");
  mkdirSync(bin, { recursive: true });
  const blocker = join(bin, "di.exe");
  writeFileSync(blocker, "unmanaged launcher");
  t.after(() => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  const shell = process.env.DI_TEST_POWERSHELL ?? "powershell.exe";
  const shellArgs = process.env.DI_TEST_POWERSHELL === undefined
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass"]
    : ["-NoProfile"];
  const result = spawnSync(shell, [...shellArgs, "-File", installer, "-DiHome", diHome, "-SkipBuild", "-SkipPathUpdate"], {
    cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  assert.equal(result.error, undefined, `PowerShell installer could not start: ${result.error?.message ?? ""}`);
  assert.notEqual(result.status, 0, "installer must reject a launcher that shadows the TypeScript default");
  assert.match(`${result.stdout}\n${result.stderr}`, /blocks the default di launcher/i);
  assert.equal(readFileSync(blocker, "utf8"), "unmanaged launcher", "existing executable must remain untouched");
});

test("isolated install installs di and di-ts TypeScript commands and preserves user files", (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "di-install-runtime-"));
  const diHome = join(tempRoot, "di-home");
  const bin = join(diHome, "bin");
  mkdirSync(bin, { recursive: true });

  const configFile = join(diHome, "config.json");
  const sessionFile = join(diHome, "sessions", "session.jsonl");
  const credentialFile = join(diHome, "auth", "chatgpt", "credentials.json");
  const configContents = Buffer.from('{"user-setting":"preserve-me"}\n', "utf8");
  writeFileSync(configFile, configContents);
  mkdirSync(dirname(sessionFile), { recursive: true });
  mkdirSync(dirname(credentialFile), { recursive: true });
  const sessionContents = Buffer.from('{"type":"session","id":"keep"}\n', "utf8");
  const credentialContents = Buffer.from('{"access_token":"keep-secret"}\n', "utf8");
  writeFileSync(sessionFile, sessionContents);
  writeFileSync(credentialFile, credentialContents);

  t.after(() => {
    const resolvedTemp = resolve(tempRoot);
    const tempBase = resolve(tmpdir());
    assert.equal(dirname(resolvedTemp), tempBase, "cleanup target must be the unique directory created by this test");
    rmSync(resolvedTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const shell = process.env.DI_TEST_POWERSHELL ?? (process.platform === "win32" ? "powershell.exe" : "pwsh");
  const shellArgs = process.platform === "win32" && process.env.DI_TEST_POWERSHELL === undefined
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass"]
    : ["-NoProfile"];
  const pathArgs = process.platform === "win32" ? ["-SkipPathUpdate"] : [];
  const install = spawnSync(
    shell,
    [...shellArgs, "-File", installer, "-DiHome", diHome, "-SkipBuild", ...pathArgs],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 120_000 },
  );
  assert.equal(install.error, undefined, `PowerShell installer could not start: ${install.error?.message ?? ""}`);
  assert.equal(install.status, 0, `isolated installer failed (exit ${install.status})\n${install.stdout}\n${install.stderr}`);
  assert.deepEqual(readFileSync(configFile), configContents, "user config.json must remain byte-identical");
  assert.deepEqual(readFileSync(sessionFile), sessionContents, "existing sessions must remain byte-identical");
  assert.deepEqual(readFileSync(credentialFile), credentialContents, "existing credentials must remain byte-identical");

  const installedEntry = join(diHome, "ts-cli", "node_modules", "@di", "coding-agent", "dist", "cli", "main.js");
  const launcher = join(bin, process.platform === "win32" ? "di-ts.cmd" : "di-ts");
  const defaultLauncher = join(bin, process.platform === "win32" ? "di.cmd" : "di");
  assert.ok(existsSync(defaultLauncher), "install must create the default global di command");
  if (process.platform !== "win32") {
    assert.notEqual(statSync(launcher).mode & 0o111, 0, "POSIX di-ts launcher must be executable");
  }
  const cli = spawnSync(
    process.platform === "win32" ? (process.env.DI_TEST_POWERSHELL ?? "powershell.exe") : launcher,
    process.platform === "win32" ? ["-NoProfile", "-Command", `& '${launcher.replaceAll("'", "''")}' --info`] : ["--info"],
    {
      cwd: tempRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, DI_HOME: diHome, DEEPSEEK_API_KEY: "" },
    },
  );
  assert.equal(cli.error, undefined, `installed CLI could not start: ${cli.error?.message ?? ""}`);
  assert.equal(cli.status, 0, `installed CLI --info failed (exit ${cli.status})\n${cli.stdout}\n${cli.stderr}`);

  const installedModules = join(diHome, "ts-cli", "node_modules");
  assert.ok(existsSync(join(installedModules, "iconv-lite", "package.json")), "iconv-lite must be present in the private installed runtime");
  assert.ok(existsSync(join(installedModules, "safer-buffer", "package.json")), "safer-buffer must be present in the private installed runtime");
  const koffiRoot = join(installedModules, "koffi");
  assert.ok(existsSync(join(koffiRoot, "package.json")), "koffi must be present in the private installed runtime");
  const koffiImport = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "const koffi = await import(process.argv[1]); if (!(koffi.version || koffi.default?.version)) process.exit(3)", pathToFileURL(join(koffiRoot, "index.js")).href],
    { cwd: tempRoot, encoding: "utf8", windowsHide: true, timeout: 30_000, env: { ...process.env, DI_HOME: diHome, DEEPSEEK_API_KEY: "", NODE_PATH: "" } },
  );
  assert.equal(koffiImport.error, undefined, `installed Koffi could not start: ${koffiImport.error?.message ?? ""}`);
  assert.equal(koffiImport.status, 0, `installed Koffi could not load its prebuilt native module (exit ${koffiImport.status})\n${koffiImport.stdout}\n${koffiImport.stderr}`);

  const undiciRoot = join(installedModules, "undici");
  assert.ok(existsSync(join(undiciRoot, "package.json")), "undici must be present in the private installed runtime");
  const undiciImport = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "const u = await import(process.argv[1]); if (typeof u.fetch !== 'function' || typeof u.ProxyAgent !== 'function') process.exit(3)", pathToFileURL(join(undiciRoot, "index.js")).href],
    { cwd: tempRoot, encoding: "utf8", windowsHide: true, timeout: 30_000, env: { ...process.env, DI_HOME: diHome, DEEPSEEK_API_KEY: "", NODE_PATH: "" } },
  );
  assert.equal(undiciImport.error, undefined, `installed Undici could not start: ${undiciImport.error?.message ?? ""}`);
  assert.equal(undiciImport.status, 0, `installed Undici could not load private fetch/ProxyAgent (exit ${undiciImport.status})\n${undiciImport.stdout}\n${undiciImport.stderr}`);

  const installedEncoding = join(dirname(installedEntry), "..", "core", "tools", "encoding.js");
  const encodingImport = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "await import(process.argv[1])", pathToFileURL(installedEncoding).href],
    {
      cwd: tempRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, DI_HOME: diHome, DEEPSEEK_API_KEY: "", NODE_PATH: "" },
    },
  );
  assert.equal(encodingImport.error, undefined, `installed runtime module could not start: ${encodingImport.error?.message ?? ""}`);
  assert.equal(
    encodingImport.status,
    0,
    `installed OEM encoding module could not load its runtime dependencies (exit ${encodingImport.status})\n${encodingImport.stdout}\n${encodingImport.stderr}`,
  );

});

test("default install is repeatable and keeps user data", (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "di-install-default-"));
  const diHome = join(tempRoot, "di-home");
  const bin = join(diHome, "bin");
  mkdirSync(bin, { recursive: true });
  const unrelatedExe = join(bin, "other-tool.exe");
  writeFileSync(unrelatedExe, "unrelated executable");
  const sentinels = [
    [join(diHome, "config.json"), "{\"keep\":true}"],
    [join(diHome, "sessions", "session.jsonl"), "session sentinel"],
    [join(diHome, "auth", "credentials.json"), "auth sentinel"],
  ] as const;
  for (const [file, contents] of sentinels) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  t.after(() => {
    assert.equal(dirname(resolve(tempRoot)), resolve(tmpdir()), "cleanup target must be the unique fixture directory");
    rmSync(resolve(tempRoot), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const shell = process.env.DI_TEST_POWERSHELL ?? (process.platform === "win32" ? "powershell.exe" : "pwsh");
  const shellArgs = process.platform === "win32" && process.env.DI_TEST_POWERSHELL === undefined
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass"] : ["-NoProfile"];
  const args = [...shellArgs, "-File", installer, "-DiHome", diHome, "-SkipBuild", ...(process.platform === "win32" ? ["-SkipPathUpdate"] : [])];
  for (let run = 0; run < 2; run++) {
    const install = spawnSync(shell, args, { cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 120_000 });
    assert.equal(install.error, undefined, `installer could not start: ${install.error?.message ?? ""}`);
    assert.equal(install.status, 0, `default install run ${run + 1} failed\n${install.stdout}\n${install.stderr}`);
    assert.deepEqual(readFileSync(unrelatedExe, "utf8"), "unrelated executable", "other executables must remain untouched");
    for (const [file, contents] of sentinels) assert.deepEqual(readFileSync(file, "utf8"), contents, `${file} must remain unchanged`);
  }
  const launcher = join(bin, process.platform === "win32" ? "di.cmd" : "di");
  const cli = spawnSync(process.platform === "win32" ? shell : launcher,
    process.platform === "win32" ? [...shellArgs, "-Command", `& '${launcher.replaceAll("'", "''")}' --info`] : ["--info"],
    { cwd: tempRoot, encoding: "utf8", windowsHide: true, timeout: 30_000, env: { ...process.env, DI_HOME: diHome, DEEPSEEK_API_KEY: "" } });
  assert.equal(cli.error, undefined, `global di shim could not start: ${cli.error?.message ?? ""}`);
  assert.equal(cli.status, 0, `global di --info must run the installed TS CLI\n${cli.stdout}\n${cli.stderr}`);
  assert.match(cli.stdout, /TypeScript|Node|@di\/coding-agent/i, "--info output must identify the TS CLI");

  const freshHome = join(tempRoot, "fresh-di-home");
  const fresh = spawnSync(shell, [...shellArgs, "-File", installer, "-DiHome", freshHome, "-SkipBuild", ...(process.platform === "win32" ? ["-SkipPathUpdate"] : [])], {
    cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 120_000,
  });
  assert.equal(fresh.error, undefined, `fresh installer could not start: ${fresh.error?.message ?? ""}`);
  assert.equal(fresh.status, 0, `fresh install failed\n${fresh.stdout}\n${fresh.stderr}`);
  assert.ok(existsSync(join(freshHome, "bin", process.platform === "win32" ? "di.cmd" : "di")), "fresh install must create a TypeScript di launcher");
});
