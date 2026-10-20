import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGlobTool, GLOB_DEFAULT_LIMIT } from "@di/coding-agent";

/**
 * P4.2 card 2: glob tool (recursive file enumeration).
 *
 * Ports Di.Tests/Tools/GlobToolTests.cs at baseline 09f4e08 and adds the red
 * cases from tools-and-platform.md §"文件 IO": ignore-dir rules (.git, bin, obj,
 * node_modules, AppData, Temp, cache…), recursion depth, path/separator
 * handling, missing/invalid args, and a truly async cancellable scan
 * (execution-plan P4 gate: a sync scan wrapped in a Promise is not acceptable).
 */

const base = mkdtempSync(join(tmpdir(), "di-glob-"));
test.after(() => rmSync(base, { recursive: true, force: true }));

function write(relative: string, content = "") {
  const parts = relative.split("/");
  mkdirSync(join(base, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(base, ...parts), content);
}

function run(args: unknown, signal?: AbortSignal) {
  return createGlobTool(base).execute(JSON.stringify(args), signal);
}

test("double star finds all recursively including the root", async () => {
  write("a.cs");
  write("src/b.cs");
  write("src/deep/c.cs");
  write("src/deep/d.txt");

  const obs = await run({ pattern: "**/*.cs" });
  assert.equal(obs.isError, false);
  const lines = obs.text.split("\n");
  assert.ok(lines.includes("a.cs"));
  assert.ok(lines.includes("src/b.cs"));
  assert.ok(lines.includes("src/deep/c.cs"));
  assert.ok(!lines.some((l) => l.endsWith(".txt")));
});

test("single star only matches the root level", async () => {
  write("a.cs");
  write("src/b.cs");

  const obs = await run({ pattern: "*.cs" });
  assert.equal(obs.text, "a.cs");
});

test("path parameter searches from a subdirectory start", async () => {
  write("src/b.cs");
  write("src/deep/c.cs");
  write("other/d.cs");

  const obs = await run({ pattern: "**/*.cs", path: "src" });
  assert.ok(!obs.text.includes("other"));
  assert.ok(obs.text.includes("b.cs"));
  assert.ok(obs.text.includes("deep/c.cs"));
});

test("no match returns the not-found marker", async () => {
  write("a.cs");
  const obs = await run({ pattern: "**/*.py" });
  assert.ok(obs.text.includes("未找到"));
});

test("concrete subtree pattern works", async () => {
  write("src/components/Button.tsx");
  write("src/components/ui/Button.tsx");
  write("src/other/Button.tsx");

  const obs = await run({ pattern: "src/components/**/Button.tsx" });
  const lines = obs.text.split("\n");
  assert.ok(lines.includes("src/components/Button.tsx"));
  assert.ok(lines.includes("src/components/ui/Button.tsx"));
  assert.ok(!obs.text.includes("src/other"));
});

test("directories are not returned as results", async () => {
  write("a/f1.txt");
  write("a/f2.txt");

  const obs = await run({ pattern: "**" });
  const lines = obs.text.split("\n");
  assert.ok(lines.includes("a/f1.txt"));
  assert.ok(lines.includes("a/f2.txt"));
  assert.ok(!lines.includes("a"));
});

test("results are relative to the search root with no absolute paths", async () => {
  write("x/deep/file.json");
  const obs = await run({ pattern: "**/*.json" });
  assert.ok(obs.text.includes("x/deep/file.json"));
  assert.ok(!obs.text.includes(base));
});

test("results use forward slashes even on Windows", async () => {
  write("x/deep/file.json");
  const obs = await run({ pattern: "**/*.json" });
  assert.ok(obs.text.includes("x/deep/file.json"));
  assert.ok(!obs.text.includes("\\"));
});

test("missing pattern returns an error naming pattern", async () => {
  const obs = await run({});
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
  assert.ok(obs.text.includes("pattern"));
});

test("nonexistent path returns an error", async () => {
  const obs = await run({ pattern: "**", path: "nope" });
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("invalid JSON arguments return an error", async () => {
  const obs = await createGlobTool(base).execute("nope");
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
});

test("invalid limit type returns an error naming limit", async () => {
  const obs = await run({ pattern: "**", limit: "many" });
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
  assert.ok(obs.text.includes("limit"));
});

test("result cap returns at most the default limit with a notice", async () => {
  for (let i = 0; i < GLOB_DEFAULT_LIMIT + 5; i++) write(`f${i}.txt`);

  const obs = await run({ pattern: "**/*.txt" });
  const lines = obs.text.split("\n").filter((l) => l.endsWith(".txt"));
  assert.equal(lines.length, GLOB_DEFAULT_LIMIT);
  assert.ok(obs.text.includes("200 条结果上限"));
});

test("limit option stops early with a continuation notice", async () => {
  for (let i = 0; i < 5; i++) write(`f${i}.txt`);

  const obs = await run({ pattern: "**/*.txt", limit: 2 });
  const lines = obs.text.split("\n").filter((l) => l.endsWith(".txt"));
  assert.equal(lines.length, 2);
  assert.ok(obs.text.includes("2 条结果上限"));
  assert.ok(obs.text.includes("limit=4"));
});

test("limit of zero clamps to one result (C# Math.Max(1, limit))", async () => {
  write("a.txt");
  write("b.txt");

  const obs = await run({ pattern: "**/*.txt", limit: 0 });
  const lines = obs.text.split("\n").filter((l) => l.endsWith(".txt"));
  assert.equal(lines.length, 1);
  assert.ok(obs.text.includes("1 条结果上限"));
});

test("windows matching is case-insensitive", async (t) => {
  if (process.platform !== "win32") {
    t.skip("case-insensitive filesystem is Windows-specific");
    return;
  }
  write("READMe.md");
  const obs = await run({ pattern: "**/readme.md" });
  assert.ok(obs.text.includes("READMe.md"));
});

test("definition has glob name and pattern schema", () => {
  const spec = createGlobTool(base).spec;
  assert.equal(spec.name, "glob");
  const props = spec.parameters.properties as Record<string, unknown>;
  assert.ok(props.pattern);
  assert.ok(props.path);
  assert.ok(props.limit);
  assert.deepEqual(spec.parameters.required, ["pattern"]);
});

test("windows separator pattern is normalized", async () => {
  write("src/a.cs");
  const obs = await run({ pattern: "src\\*.cs" });
  assert.ok(obs.text.includes("src/a.cs"));
});

test("question mark matches exactly one character", async () => {
  write("a.txt");
  write("ab.txt");
  const obs = await run({ pattern: "?.txt" });
  assert.ok(obs.text.includes("a.txt"));
  assert.ok(!obs.text.includes("ab.txt"));
});

test("unicode filenames are matched", async () => {
  write("报告.md");
  const obs = await run({ pattern: "**/*.md" });
  assert.ok(obs.text.includes("报告.md"));
});

test("path that is a file returns an error", async () => {
  write("file.txt");
  const obs = await run({ pattern: "**", path: "file.txt" });
  assert.ok(obs.isError);
  assert.ok(obs.text.startsWith("error:"));
  assert.ok(obs.text.includes("文件"));
});

test("empty directory returns not-found", async () => {
  mkdirSync(join(base, "empty"));
  const obs = await run({ pattern: "**", path: "empty" });
  assert.ok(obs.text.includes("未找到"));
});

test("dotfiles are matched", async () => {
  write(".gitignore");
  const obs = await run({ pattern: "*" });
  assert.ok(obs.text.includes(".gitignore"));
});

test("skips build, dependency, VCS and cache directories by name", async () => {
  write("src/real.cs");
  write("obj/Debug/generated.cs");
  write("bin/Debug/output.cs");
  write("node_modules/pkg/index.cs");
  write("some/.git/objects/x.cs");
  write(".hg/store.cs");
  write(".svn/entries.cs");
  write(".vs/sln.cs");
  write(".idea/workspace.cs");
  write("__pycache__/p.cs");
  write(".venv/lib/v.cs");
  write("venv/lib/w.cs");
  write("AppData/Local/z.cs");
  write("Temp/w.cs");
  write("cache/dir/y.cs");
  write("Caches/dir/y.cs");
  write(".cache/dir/y.cs");

  const obs = await run({ pattern: "**/*.cs" });
  assert.ok(obs.text.includes("src/real.cs"));
  assert.ok(!obs.text.includes("obj/"));
  assert.ok(!obs.text.includes("bin/"));
  assert.ok(!obs.text.includes("node_modules"));
  assert.ok(!obs.text.includes(".git"));
  assert.ok(!obs.text.includes(".hg"));
  assert.ok(!obs.text.includes(".svn"));
  assert.ok(!obs.text.includes(".vs"));
  assert.ok(!obs.text.includes(".idea"));
  assert.ok(!obs.text.includes("__pycache__"));
  assert.ok(!obs.text.includes(".venv"));
  assert.ok(!obs.text.includes("venv"));
  assert.ok(!obs.text.includes("AppData"));
  assert.ok(!obs.text.includes("Temp"));
  assert.ok(!obs.text.includes("cache"));
  assert.ok(!obs.text.includes("Caches"));
  assert.ok(!obs.text.includes(".cache"));
});

test("excluded directory names are matched case-insensitively", async () => {
  write("src/real.cs");
  write("NODE_MODULES/pkg/index.cs");
  write("Obj/Generated/x.cs");
  const obs = await run({ pattern: "**/*.cs" });
  assert.ok(obs.text.includes("src/real.cs"));
  assert.ok(!obs.text.includes("NODE_MODULES"));
  assert.ok(!obs.text.includes("Obj"));
});

test("trailing slash pattern is harmless", async () => {
  write("src/a.cs");
  const obs = await run({ pattern: "src/" });
  assert.ok(obs.text.includes("未找到"));
});

test("deep recursion is handled", async () => {
  write("a/b/c/d/e/f/g/h/i/j/k.cs");
  const obs = await run({ pattern: "**/*.cs" });
  assert.ok(obs.text.includes("a/b/c/d/e/f/g/h/i/j/k.cs"));
});

test("path argument that is not a string is ignored (C# TryGetOptionalString)", async () => {
  write("a.cs");
  const obs = await run({ pattern: "*.cs", path: 42 });
  assert.equal(obs.isError, false);
  assert.ok(obs.text.includes("a.cs"));
});

test("pre-aborted signal rejects with AbortError", async () => {
  write("a.cs");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => run({ pattern: "**/*.cs" }, controller.signal),
    { name: "AbortError" },
  );
});

test("abort during the scan rejects with AbortError (async cancellable walk)", async () => {
  // A tree large enough that the walk spans many awaited readdir boundaries, so
  // an abort issued from a timer lands mid-scan and is observed at a boundary.
  // The search is scoped to its own root so files created by earlier tests in
  // the shared base cannot trip the 200-result cap before the abort lands.
  for (let i = 0; i < 400; i++) write(`abort-scan/d${i}/x.txt`);

  const controller = new AbortController();
  const promise = run({ pattern: "**/*.txt", path: "abort-scan" }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(promise, { name: "AbortError" });
});

test("scan budget exceeded returns partial results with a notice", async () => {
  for (let i = 0; i < 2000; i++) write(`f${String(i).padStart(4, "0")}.txt`);

  const tool = createGlobTool(base, { scanBudgetMs: 1 });
  const obs = await tool.execute(JSON.stringify({ pattern: "**/*.txt" }));
  assert.ok(obs.text.includes("扫描超过"));
});

test("symlink/junction directories are not descended into (cycle safety)", async (t) => {
  // Scoped to its own search root so leftover files in the shared base cannot
  // trip the result cap before the walk reaches the link.
  write("cycle/real/f.txt");
  try {
    // Windows junctions need no privileges; POSIX uses a directory symlink.
    // Point the link back at the search root itself: descending would cycle.
    symlinkSync(join(base, "cycle"), join(base, "cycle", "loop"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`directory links unavailable here: ${(error as Error).message}`);
    return;
  }

  const obs = await run({ pattern: "**/*.txt", path: "cycle" });
  assert.ok(obs.text.includes("real/f.txt"));
  assert.ok(!obs.text.includes("loop/"));
});

test("symlink files are yielded like regular files", async (t) => {
  write("target.txt", "x");
  try {
    symlinkSync(join(base, "target.txt"), join(base, "link.txt"), "file");
  } catch (error) {
    t.skip(`file symlinks unavailable here: ${(error as Error).message}`);
    return;
  }

  const obs = await run({ pattern: "*.txt" });
  assert.ok(obs.text.includes("target.txt"));
  assert.ok(obs.text.includes("link.txt"));
});
