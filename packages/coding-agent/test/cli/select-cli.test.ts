import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const installer = join(repoRoot, "install.ps1");
const selector = join(repoRoot, "tools", "select-cli.ps1");
const powershell = process.env.DI_TEST_POWERSHELL ?? (process.platform === "win32" ? "powershell.exe" : "pwsh");
const powershellArgs = process.platform === "win32" && process.env.DI_TEST_POWERSHELL === undefined
  ? ["-NoProfile", "-ExecutionPolicy", "Bypass"]
  : ["-NoProfile"];

test("isolated CLI selector switches to TS and restores the exact C# launcher", (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "di-select-cli-"));
  const diHome = join(tempRoot, "di-home");
  const bin = join(diHome, "bin");
  mkdirSync(bin, { recursive: true });

  const csharpName = process.platform === "win32" ? "di.exe" : "di";
  const backupName = process.platform === "win32" ? "di-csharp.exe" : "di-csharp";
  const csharp = join(bin, csharpName);
  const backup = join(bin, backupName);
  const original = Buffer.from("C# launcher bytes\0\xff\n", "binary");
  writeFileSync(csharp, original);

  t.after(() => {
    const resolvedTemp = resolve(tempRoot);
    assert.equal(dirname(resolvedTemp), resolve(tmpdir()), "cleanup target must be the unique directory created by this test");
    rmSync(resolvedTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const install = spawnSync(powershell, [...powershellArgs, "-File", installer, "-DiHome", diHome, "-SkipBuild", ...(process.platform === "win32" ? ["-SkipPathUpdate"] : [])], {
    cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 120_000,
  });
  assert.equal(install.error, undefined, `isolated installer could not start: ${install.error?.message ?? ""}`);
  assert.equal(install.status, 0, `isolated TS install failed\n${install.stdout}\n${install.stderr}`);

  const select = (runtime: "typescript" | "csharp") => spawnSync(
    powershell,
    [...powershellArgs, "-File", selector, "-Runtime", runtime, "-DiHome", diHome],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  const assertSelected = (runtime: "typescript" | "csharp") => {
    const result = select(runtime);
    assert.equal(result.error, undefined, `selector could not start: ${result.error?.message ?? ""}`);
    assert.equal(result.status, 0, `${runtime} selection failed\n${result.stdout}\n${result.stderr}`);
  };

  assertSelected("typescript");
  assert.deepEqual(readFileSync(backup), original, "C# launcher must be preserved byte-for-byte");
  assert.ok(existsSync(join(bin, process.platform === "win32" ? "di.cmd" : "di")), "TS launcher must own the di entry");
  const launcher = join(bin, process.platform === "win32" ? "di.cmd" : "di");
  const cli = spawnSync(
    process.platform === "win32" ? "powershell.exe" : launcher,
    process.platform === "win32" ? ["-NoProfile", "-Command", `& '${launcher.replaceAll("'", "''")}' --info`] : ["--info"],
    { cwd: tempRoot, encoding: "utf8", windowsHide: true, timeout: 30_000, env: { ...process.env, DI_HOME: diHome, DEEPSEEK_API_KEY: "" } },
  );
  assert.equal(cli.error, undefined, `TS launcher could not start: ${cli.error?.message ?? ""}`);
  assert.equal(cli.status, 0, `TS di --info failed\n${cli.stdout}\n${cli.stderr}`);
  assertSelected("typescript"); // idempotent
  if (process.platform === "win32") {
    const shadow = join(bin, "di.exe");
    const shadowBytes = Buffer.from("new higher-priority executable");
    writeFileSync(shadow, shadowBytes);
    const idempotentShadow = select("typescript");
    assert.equal(idempotentShadow.status, 1, `TS idempotence must reject a higher-priority di.exe\n${idempotentShadow.stdout}\n${idempotentShadow.stderr}`);
    assert.match(`${idempotentShadow.stdout}\n${idempotentShadow.stderr}`, /higher-priority Windows launcher/);
    assert.deepEqual(readFileSync(shadow), shadowBytes, "higher-priority launcher must remain untouched");
    unlinkSync(shadow);
  }
  assertSelected("csharp");
  assert.deepEqual(readFileSync(csharp), original, "C# launcher must be restored byte-for-byte");
  assert.equal(existsSync(backup), false, "C# backup must be moved back");
  if (process.platform === "win32") {
    assert.equal(existsSync(launcher), false, "owned TS cmd shim must be removed on rollback");
  } else {
    assert.deepEqual(readFileSync(launcher), original, "POSIX di path must be restored to the original C# launcher");
  }
  assertSelected("csharp"); // idempotent
  const parallelLauncher = join(bin, process.platform === "win32" ? "di-ts.cmd" : "di-ts");
  const parallel = spawnSync(
    process.platform === "win32" ? "powershell.exe" : parallelLauncher,
    process.platform === "win32" ? ["-NoProfile", "-Command", `& '${parallelLauncher.replaceAll("'", "''")}' --info`] : ["--info"],
    { cwd: tempRoot, encoding: "utf8", windowsHide: true, timeout: 30_000, env: { ...process.env, DI_HOME: diHome, DEEPSEEK_API_KEY: "" } },
  );
  assert.equal(parallel.status, 0, `parallel di-ts must remain usable after rollback\n${parallel.stdout}\n${parallel.stderr}`);

  const conflictHome = join(tempRoot, "conflict-home");
  const conflictBin = join(conflictHome, "bin");
  mkdirSync(conflictBin, { recursive: true });
  const conflictOriginal = join(conflictBin, csharpName);
  const conflictBackup = join(conflictBin, backupName);
  writeFileSync(conflictOriginal, original);
  writeFileSync(conflictBackup, "unowned file");
  const conflictTsEntry = join(conflictHome, "ts-cli", "node_modules", "@di", "coding-agent", "dist", "cli", "main.js");
  mkdirSync(dirname(conflictTsEntry), { recursive: true });
  writeFileSync(join(conflictBin, process.platform === "win32" ? "di-ts.cmd" : "di-ts"), "TS marker");
  writeFileSync(conflictTsEntry, "TS entry marker");
  const conflict = spawnSync(powershell, [...powershellArgs, "-File", selector, "-Runtime", "typescript", "-DiHome", conflictHome], {
    cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  assert.equal(conflict.status, 1, `reserved backup conflict must fail\n${conflict.stdout}\n${conflict.stderr}`);
  assert.match(`${conflict.stdout}\n${conflict.stderr}`, /Reserved C# backup already exists/, "fixture must reach the reserved backup guard");
  assert.deepEqual(readFileSync(conflictOriginal), original, "conflict must not move or rewrite the original launcher");
  assert.equal(readFileSync(conflictBackup, "utf8"), "unowned file", "conflicting backup must remain untouched");

  const shimConflictHome = join(tempRoot, "shim-conflict-home");
  const shimConflictBin = join(shimConflictHome, "bin");
  const fakeTsEntry = join(shimConflictHome, "ts-cli", "node_modules", "@di", "coding-agent", "dist", "cli", "main.js");
  mkdirSync(shimConflictBin, { recursive: true });
  mkdirSync(dirname(fakeTsEntry), { recursive: true });
  writeFileSync(join(shimConflictBin, csharpName), original);
  writeFileSync(join(shimConflictBin, process.platform === "win32" ? "di-ts.cmd" : "di-ts"), "TS marker");
  writeFileSync(fakeTsEntry, "TS entry marker");
  if (process.platform === "win32") {
    const unownedShim = join(shimConflictBin, "di.cmd");
    writeFileSync(unownedShim, "user-owned launcher");
    const shimConflict = spawnSync(powershell, [...powershellArgs, "-File", selector, "-Runtime", "typescript", "-DiHome", shimConflictHome], {
      cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 30_000,
    });
    assert.equal(shimConflict.status, 1, `unmanaged di.cmd conflict must fail\n${shimConflict.stdout}\n${shimConflict.stderr}`);
    assert.match(`${shimConflict.stdout}\n${shimConflict.stderr}`, /Unmanaged launcher already exists/);
    assert.equal(readFileSync(unownedShim, "utf8"), "user-owned launcher", "unmanaged shim must remain untouched");
    assert.deepEqual(readFileSync(join(shimConflictBin, csharpName)), original, "shim conflict must leave the C# launcher in place");

    for (const extension of ["com", "bat", "ps1"]) {
      const priorityHome = join(tempRoot, `priority-${extension}-home`);
      const priorityBin = join(priorityHome, "bin");
      const priorityEntry = join(priorityHome, "ts-cli", "node_modules", "@di", "coding-agent", "dist", "cli", "main.js");
      mkdirSync(priorityBin, { recursive: true });
      mkdirSync(dirname(priorityEntry), { recursive: true });
      const priorityOriginal = join(priorityBin, "di.exe");
      const priorityFile = join(priorityBin, `di.${extension}`);
      writeFileSync(priorityOriginal, original);
      writeFileSync(join(priorityBin, "di-ts.cmd"), "TS marker");
      writeFileSync(priorityEntry, "TS entry marker");
      const priorityBytes = Buffer.from(`unmanaged .${extension} launcher`);
      writeFileSync(priorityFile, priorityBytes);
      const blocked = spawnSync(powershell, [...powershellArgs, "-File", selector, "-Runtime", "typescript", "-DiHome", priorityHome], {
        cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 30_000,
      });
      assert.equal(blocked.status, 1, `di.${extension} must block TS selection\n${blocked.stdout}\n${blocked.stderr}`);
      assert.match(`${blocked.stdout}\n${blocked.stderr}`, /higher-priority Windows launcher/);
      assert.deepEqual(readFileSync(priorityOriginal), original, `di.${extension} conflict must preserve the C# launcher`);
      assert.deepEqual(readFileSync(priorityFile), priorityBytes, `di.${extension} conflict must remain untouched`);
    }
  }
});
