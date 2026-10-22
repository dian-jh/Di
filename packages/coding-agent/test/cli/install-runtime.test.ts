import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const installer = join(repoRoot, "install.ps1");

test("isolated install copies all CLI runtime dependencies and preserves user files", { skip: process.platform !== "win32" }, (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "di-install-runtime-"));
  const diHome = join(tempRoot, "di-home");
  const bin = join(diHome, "bin");
  mkdirSync(bin, { recursive: true });

  const csharpMarker = join(bin, "di.exe");
  const configFile = join(diHome, "config.json");
  const markerContents = Buffer.from("existing C# launcher marker\n", "utf8");
  const configContents = Buffer.from('{"user-setting":"preserve-me"}\n', "utf8");
  writeFileSync(csharpMarker, markerContents);
  writeFileSync(configFile, configContents);

  t.after(() => {
    const resolvedTemp = resolve(tempRoot);
    const tempBase = resolve(tmpdir());
    assert.equal(dirname(resolvedTemp), tempBase, "cleanup target must be the unique directory created by this test");
    rmSync(resolvedTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const install = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer, "-DiHome", diHome, "-SkipBuild", "-SkipPathUpdate"],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 120_000 },
  );
  assert.equal(install.error, undefined, `PowerShell installer could not start: ${install.error?.message ?? ""}`);
  assert.equal(install.status, 0, `isolated installer failed (exit ${install.status})\n${install.stdout}\n${install.stderr}`);
  assert.deepEqual(readFileSync(csharpMarker), markerContents, "existing C# di.exe must remain byte-identical");
  assert.deepEqual(readFileSync(configFile), configContents, "user config.json must remain byte-identical");

  const installedEntry = join(diHome, "ts-cli", "node_modules", "@di", "coding-agent", "dist", "cli", "main.js");
  const cli = spawnSync(process.execPath, [installedEntry, "--info"], {
    cwd: tempRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, DI_HOME: diHome, DEEPSEEK_API_KEY: "" },
  });
  assert.equal(cli.error, undefined, `installed CLI could not start: ${cli.error?.message ?? ""}`);
  assert.equal(cli.status, 0, `installed CLI --info failed (exit ${cli.status})\n${cli.stdout}\n${cli.stderr}`);

  const installedModules = join(diHome, "ts-cli", "node_modules");
  assert.ok(existsSync(join(installedModules, "iconv-lite", "package.json")), "iconv-lite must be present in the private installed runtime");
  assert.ok(existsSync(join(installedModules, "safer-buffer", "package.json")), "safer-buffer must be present in the private installed runtime");
  const koffiRoot = join(installedModules, "koffi");
  assert.ok(existsSync(join(koffiRoot, "package.json")), "koffi must be present in the private installed runtime");
  assert.ok(existsSync(join(koffiRoot, "build", "koffi", "win32_x64", "koffi.node")), "prebuilt Windows x64 Koffi binary must be copied");

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
