import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const installer = join(repoRoot, "install.ps1");

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
