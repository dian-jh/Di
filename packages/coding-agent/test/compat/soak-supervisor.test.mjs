import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const supervisor = join(repo, "packages/coding-agent/test/soak/soak-supervisor.mjs");

test("soak supervisor records immutable run provenance, memory samples, and child exit", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "di-soak-supervisor-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [supervisor, "--root", temp, "--duration-min", "0", "--phase", "supervisor-test"], {
    cwd: repo, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const [runId] = readdirSync(temp);
  assert.ok(runId);
  const runRoot = join(temp, runId);
  const parent = JSON.parse(readFileSync(join(runRoot, "supervisor.json"), "utf8"));
  const exit = JSON.parse(readFileSync(join(runRoot, "exit.json"), "utf8"));
  const run = JSON.parse(readFileSync(join(runRoot, "artifacts", "run.json"), "utf8"));
  const sample = JSON.parse(readFileSync(join(runRoot, "artifacts", "samples.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.equal(parent.runId, runId);
  assert.equal(exit.runId, runId);
  assert.equal(exit.exitCode, 0);
  assert.equal(run.runId, runId);
  assert.equal(typeof parent.gitSha, "string");
  assert.equal(typeof sample.external_bytes, "number");
  assert.equal(typeof sample.array_buffers_bytes, "number");
  assert.equal(typeof sample.js_handle_count, "number");
  assert.ok(Object.hasOwn(sample, "os_handle_count"));
  assert.ok(Object.hasOwn(sample, "working_set_bytes"));
  assert.ok(Object.hasOwn(sample, "peak_working_set_bytes"));
  assert.ok(Object.hasOwn(sample, "private_bytes"));
  assert.equal(typeof sample.v8_total_heap_size_bytes, "number");
  assert.equal(typeof sample.v8_total_physical_size_bytes, "number");
  assert.equal(typeof sample.v8_malloced_memory_bytes, "number");
  assert.equal(typeof sample.v8_peak_malloced_memory_bytes, "number");
});
