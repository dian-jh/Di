import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateSoakPaths } from "../soak/soak-path-validation.mjs";

const repo = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const runner = join(repo, "packages/coding-agent/test/soak/soak-runner.mjs");

test("soak path validation rejects missing and swallowed required values", () => {
  const valid = { mode: "run", diHome: "C:/temp/run/di-home", out: "C:/temp/run/artifacts", workspace: "C:/repo", repo, home: "C:/Users/test" };
  assert.throws(() => validateSoakPaths({ ...valid, diHome: undefined }), /--di-home.*required/i);
  assert.throws(() => validateSoakPaths({ ...valid, diHome: "--out" }), /--di-home.*value/i);
  assert.throws(() => validateSoakPaths({ ...valid, out: "" }), /--out.*required/i);
  assert.throws(() => validateSoakPaths({ ...valid, workspace: "--out" }), /--workspace.*value/i);
});

test("soak home must be a child of the artifact run root and outside protected roots", () => {
  const base = mkdtempSync(join(tmpdir(), "di-soak-path-validation-"));
  try {
    const runRoot = join(base, "run");
    const valid = { mode: "run", diHome: join(runRoot, "di-home"), out: join(runRoot, "artifacts"), workspace: repo, repo, home: join(base, "profile") };
    assert.deepEqual(validateSoakPaths(valid), {
      diHome: resolve(valid.diHome), out: resolve(valid.out), workspace: resolve(repo),
    });
    assert.throws(() => validateSoakPaths({ ...valid, diHome: join(base, "outside-home") }), /inside.*artifact/i);
    assert.throws(() => validateSoakPaths({ ...valid, diHome: homedir(), out: join(dirname(homedir()), "artifacts"), home: homedir() }), /protected|profile/i);
    assert.throws(() => validateSoakPaths({ ...valid, diHome: join(homedir(), ".di"), out: join(homedir(), "artifacts"), home: homedir() }), /protected|profile|user data/i);
    assert.throws(() => validateSoakPaths({
      ...valid, diHome: join(homedir(), ".di", "auth"), out: join(homedir(), ".di", "artifacts"), home: homedir(),
    }), /protected|profile|user data/i);
    assert.doesNotThrow(() => validateSoakPaths({
      ...valid, diHome: join(homedir(), "AppData", "Local", "Temp", "soak-home"),
      out: join(homedir(), "AppData", "Local", "Temp", "artifacts"), home: homedir(),
    }), "TEMP under the profile is allowed when DI_HOME is neither the profile nor its ancestor");
    assert.throws(() => validateSoakPaths({ ...valid, diHome: repo }), /inside.*artifact|protected/i);
    assert.throws(() => validateSoakPaths({ ...valid, diHome: dirname(repo), out: join(dirname(repo), "artifacts") }), /inside.*artifact|protected/i);
    const protectedWorkspace = join(base, "project");
    assert.throws(() => validateSoakPaths({
      mode: "run", diHome: base, out: join(dirname(base), "artifacts"), workspace: protectedWorkspace,
      repo: protectedWorkspace, home: join(dirname(base), "other-profile"),
    }), /repository\/workspace/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("invalid run and child paths are rejected before creating output or constructing the host", (t) => {
  const base = mkdtempSync(join(tmpdir(), "di-soak-no-side-effects-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const out = join(base, "run", "artifacts-must-not-exist");
  const outsideHome = join(base, "outside", "di-home");
  const workspace = join(base, "workspace-must-not-exist");
  const cases = [
    ["run", ["--di-home", outsideHome, "--workspace", workspace, "--out", out, "--duration-min", "0"]],
    ["child", ["--di-home", "--workspace", "--workspace", workspace, "--session", join(base, "missing-session.jsonl"), "--out", out]],
  ];
  for (const [mode, args] of cases) {
    const result = spawnSync(process.execPath, [runner, mode, ...args], { cwd: base, encoding: "utf8", timeout: 10_000 });
    assert.notEqual(result.status, 0, `${mode} with unsafe/missing home must fail`);
    assert.match(`${result.stderr}\n${result.stdout}`, /--di-home|inside.*artifact|protected/i);
    assert.equal(existsSync(out), false, `${mode} must not create output before validation`);
    assert.equal(existsSync(workspace), false, `${mode} must not create workspace or host side effects`);
  }
  assert.deepEqual(readdirSync(base), [], "validation failure must leave the fixture root untouched");
});
