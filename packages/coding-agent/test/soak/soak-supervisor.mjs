#!/usr/bin/env node
/** Isolated soak launcher that preserves run provenance and runner exit status. */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const runner = fileURLToPath(new URL("./soak-runner.mjs", import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const next = argv[i + 1];
    out[key.slice(2)] = next !== undefined && !next.startsWith("--") ? next : "true";
    if (next !== undefined && !next.startsWith("--")) i++;
  }
  return out;
}

function runIdNow() {
  return `p9-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

const args = parseArgs(process.argv.slice(2));
if (!args.root) throw new Error("--root <artifact-parent-outside-repository> is required");
const artifactRoot = resolve(args.root);
const relativeToRepo = relative(repo, artifactRoot);
if (relativeToRepo === "" || (!relativeToRepo.startsWith("..") && !isAbsolute(relativeToRepo))) {
  throw new Error("artifact root must be outside the repository");
}
const runId = args["run-id"] ?? runIdNow();
const runRoot = join(artifactRoot, runId);
if (existsSync(runRoot)) throw new Error(`run directory already exists; refusing to reuse it: ${runRoot}`);
const out = join(runRoot, "artifacts");
const diHome = join(runRoot, "di-home");
mkdirSync(out, { recursive: true });
mkdirSync(diHome, { recursive: true });

let manifestCopy;
let manifestSha256;
if (args.manifest) {
  manifestCopy = join(runRoot, "manifest.json");
  copyFileSync(resolve(args.manifest), manifestCopy);
  manifestSha256 = createHash("sha256").update(readFileSync(manifestCopy)).digest("hex");
}

const childArgs = [runner, "run", "--di-home", diHome, "--workspace", repo, "--out", out,
  "--run-id", runId, "--phase", args.phase ?? "full",
  "--duration-min", args["duration-min"] ?? "600",
  "--sample-interval-sec", args["sample-interval-sec"] ?? "30",
  "--resume-every-turns", args["resume-every-turns"] ?? "300",
  "--clear-every-turns", args["clear-every-turns"] ?? "30",
  "--turn-delay-ms", args["turn-delay-ms"] ?? "200"];
const startMs = Date.now();
const git = (gitArgs) => {
  try { return execFileSync("git", gitArgs, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
};
const dirtyPaths = (git(["status", "--porcelain"]) ?? "").split("\n").filter(Boolean);
const supervisorRecord = {
  runId,
  startUtc: new Date(startMs).toISOString(),
  host: hostname(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  gitSha: git(["rev-parse", "HEAD"]),
  dirty: dirtyPaths.length > 0,
  dirtyPaths,
  workspace: repo,
  artifactRoot: runRoot,
  diHome,
  manifest: manifestCopy ?? null,
  manifestSha256: manifestSha256 ?? null,
  childExecutable: process.execPath,
  childArgs,
};
writeFileSync(join(runRoot, "supervisor.json"), JSON.stringify(supervisorRecord, null, 2));

const stdout = createWriteStream(join(runRoot, "runner.stdout.log"), { flags: "wx" });
const stderr = createWriteStream(join(runRoot, "runner.stderr.log"), { flags: "wx" });
const child = spawn(process.execPath, childArgs, { cwd: repo, env: { ...process.env, DI_HOME: diHome }, windowsHide: true });
child.stdout.pipe(stdout);
child.stderr.pipe(stderr);
let childError;
child.once("error", (error) => { childError = `${error.name}: ${error.message}`; });

const result = await new Promise((resolveExit) => {
  child.once("close", (code, signal) => resolveExit({ code, signal }));
});
await Promise.all([finished(stdout), finished(stderr)]);
const endMs = Date.now();
const exitRecord = {
  runId,
  startUtc: supervisorRecord.startUtc,
  endUtc: new Date(endMs).toISOString(),
  wallClockMs: endMs - startMs,
  exitCode: result.code,
  signal: result.signal,
  childError: childError ?? null,
};
writeFileSync(join(runRoot, "exit.json"), JSON.stringify(exitRecord, null, 2));
process.stdout.write(`${JSON.stringify({ runId, runRoot, ...exitRecord })}\n`);
process.exitCode = result.code ?? 1;
