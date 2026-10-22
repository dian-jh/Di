import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../../src/core/sessions/session-log.ts";
import { loadRecovery } from "../../src/core/sessions/session-recovery.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const harnessProject = resolve(dirname(fileURLToPath(import.meta.url)), "csharp-session-harness/CSharpSessionHarness.csproj");
const expected = [
  { role: "user", text: "interop user" },
  {
    role: "assistant",
    text: "interop answer",
    reasoning: "private reasoning",
    tool_calls: [{ id: "call-1", name: "echo", arguments: '{"value":"雪"}' }],
  },
  { role: "tool", text: "tool result", call_id: "call-1", is_error: false },
];
const baseline = "09f4e0816c1b2dc42461e79a968b46e811d3880c";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", cwd: repo, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function canonical(messages) {
  return messages.map((message) => {
    if (message.role === "user") return { role: "user", text: message.content.map((b) => b.text ?? "").join("") };
    if (message.role === "assistant") {
      const calls = message.content.filter((b) => b.type === "tool-call").map(({ id, name, arguments: args }) => ({ id, name, arguments: args }));
      return {
        role: "assistant",
        text: message.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
        reasoning: message.content.find((b) => b.type === "reasoning")?.text ?? null,
        tool_calls: calls,
      };
    }
    return { role: "tool", text: message.content, call_id: message.toolCallId, is_error: message.isError };
  });
}

const root = mkdtempSync(join(tmpdir(), "di-csharp-session-interop-"));
try {
  const archive = spawnSync("git", ["archive", "--format=tar", baseline, "Core", "Common"], {
    cwd: repo,
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(archive.status, 0, `cannot archive pinned C# baseline: ${archive.stderr}`);
  const baselineRoot = join(root, "baseline");
  mkdirSync(baselineRoot, { recursive: true });
  const extract = spawnSync("tar", ["-xf", "-"], {
    input: archive.stdout,
    encoding: "utf8",
    cwd: baselineRoot,
  });
  assert.equal(extract.status, 0, `cannot extract pinned C# baseline: ${extract.stderr}`);
  const tsRoot = join(root, "ts");
  const store = new SessionStore({ rootDirectory: tsRoot, now: () => "2026-10-21T00:00:00.000Z" });
  store.beginCheckpointTurn("interop user", Date.now());
  store.appendCheckpointMessage({
    role: "assistant",
    content: [
      { type: "reasoning", text: "private reasoning" },
      { type: "text", text: "interop answer" },
      { type: "tool-call", id: "call-1", name: "echo", arguments: '{"value":"雪"}' },
    ],
  });
  store.checkpointToolStarted({ id: "call-1", name: "echo", arguments: '{"value":"雪"}' });
  store.checkpointToolCompleted({ role: "tool", toolCallId: "call-1", content: "tool result", isError: false });
  const dotnetArgs = ["run", "--project", harnessProject, "--no-launch-profile", "-p:BaselineRoot=" + baselineRoot, "--"];
  assert.deepEqual(JSON.parse(run("dotnet", [...dotnetArgs, "read", store.logFilePath])), expected);

  const csharpFile = run("dotnet", [...dotnetArgs, "write", join(root, "csharp")]);
  const hashBefore = createHash("sha256").update(readFileSync(csharpFile)).digest("hex");
  assert.deepEqual(canonical(loadRecovery(csharpFile)), expected);
  const hashAfter = createHash("sha256").update(readFileSync(csharpFile)).digest("hex");
  assert.equal(hashAfter, hashBefore, "TypeScript reader must not modify the C# writer artifact");

  const incomplete = run("dotnet", [...dotnetArgs, "write", join(root, "csharp-incomplete"), "incomplete"]);
  const rejected = spawnSync("dotnet", [...dotnetArgs, "read", incomplete], { encoding: "utf8", cwd: repo });
  assert.notEqual(rejected.status, 0, "C# reference reader must reject a started tool without a durable result");
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /call-1|unknown|未完成|结果/i);
  console.log("C# writer -> TypeScript reader: PASS");
  console.log("TypeScript writer -> C# SessionLog.LoadRecovery: PASS");
  console.log("C# reader rejects unknown tool outcome: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
