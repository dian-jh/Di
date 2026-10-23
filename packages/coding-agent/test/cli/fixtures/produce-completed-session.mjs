
//
// An independent Node process that imports the committed @di/coding-agent dist
// and, using the REAL SessionStore, writes a COMPLETED session into an isolated

// but with the real `write_file` tool name and a real side-effect file written
// through the real tool executor:
//
//   one turn, two tool calls in one assistant batch:
//     c1 = write_file  → executes, writes <workspace>/side-effects.log (1 line),
//                        its result is checkpointed (checkpoint_tool_completed)
//     c2 = write_file  → never starts (partial batch completes)
//   completeCheckpointTurn  → the turn is durably completed
//

// RESTART in the parent test MUST go through the real CLI production chain
// (`node dist/cli/main.js --mode rpc --resume <file>`), never through this
// fixture or a test host — the "no side-effect replay" proof is the
// side-effects.log line count staying at exactly 1 across production + restart.
//
// Usage: node produce-completed-session.mjs <workspace> <diHome> <markerPath>
//   - writes the session JSONL under <diHome>/sessions/...
//   - writes <workspace>/side-effects.log with exactly one line ("ran c1")
//   - writes <markerPath> = JSON { logFilePath, pid } so the parent knows the
//     exact session file to pass to `--resume`
//   - exits 0
//
// Why this lives in test/cli/fixtures/ instead of test/child-test-host/: it is
// the scenario-C producer for THIS card (crash-resume through the real CLI), and
// keeping it beside test/cli/crash-resume.test.ts keeps the card's inputs local;

// an .mjs (not .mts) so `node` runs it directly with zero type-stripping setup,
// exactly like host.mjs does.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore, createFileTools, createToolExecutor } from "@di/coding-agent";

const [, , workspace, diHome, markerPath] = process.argv;

if (!workspace || !diHome || !markerPath) {
  console.error("usage: produce-completed-session.mjs <workspace> <diHome> <markerPath>");
  process.exit(2);
}

const sideEffectsPath = join(workspace, "side-effects.log");

function die(message, code = 2) {
  console.error(message);
  process.exit(code);
}

async function main() {
  const store = new SessionStore({ rootDirectory: diHome });
  const calls = [
    { id: "c1", name: "write_file", arguments: JSON.stringify({ path: "side-effects.log", content: "ran c1\n" }) },
    { id: "c2", name: "write_file", arguments: JSON.stringify({ path: "other.log", content: "should never run\n" }) },
  ];

  store.startSession();
  store.beginCheckpointTurn("write side effect file", Date.now(), []);
  store.appendCheckpointMessage({
    role: "assistant",
    content: [{ type: "text", text: "写入副作用文件" }, ...calls.map((c) => ({ type: "tool-call", id: c.id, name: c.name, arguments: c.arguments }))],
  });
  store.checkpointToolStarted(calls[0]);

  // Execute c1 through the REAL write_file tool over the temp workspace. The
  // returned observation text is the durable c1 result checkpointed below.
  const executor = createToolExecutor(createFileTools(workspace));
  const observation = await executor.execute(calls[0]);
  if (observation.isError) die(`write_file c1 failed: ${observation.text}`);
  store.checkpointToolCompleted({ role: "tool", toolCallId: "c1", content: observation.text, isError: false });
  store.completeCheckpointTurn({ stopReason: "answer", iterations: 1 });

  // The real side effect must exist and hold exactly one line.
  if (!existsSync(sideEffectsPath)) die("side-effects.log was not written by write_file c1");
  const lines = readFileSync(sideEffectsPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length !== 1) die(`side-effects.log has ${lines.length} lines, expected exactly 1`);

  writeFileSync(markerPath, JSON.stringify({ logFilePath: store.logFilePath, pid: process.pid }));
  console.log(`produced ${store.logFilePath}`);
  process.exit(0);
}

main();
