
//
// A real independent Node process that imports the committed @di/coding-agent
// dist and drives a REAL session store in an isolated DI_HOME, exactly like a
// production host would. The parent test force-kills it mid-turn (process-tree
// kill via runProcess), then relaunches it against the SAME session file to
// verify the crash/resume gate: results are preserved and the host never replays
// side effects (unknown outcomes fail closed; completed results are reused).
//
// Modes:
//   run <diHome> <killPoint>       phase 1: write a checkpointed turn with a real
//                                  side effect, then park (parent kills us).
//                                  killPoint = "after-completed" (tool result
//                                  durable) or "after-started" (tool started but
//                                  NO completed checkpoint).
//   resume <diHome>                phase 2: loadRecovery, verify the tool result
//                                  is preserved and the never-started tool got the
//                                  explicit "not executed" note; MUST NOT re-run
//                                  any tool (side-effect log unchanged). Exit 0.
//   resume-unknown <diHome>        phase 2 for a started-but-not-completed kill:
//                                  recovery MUST reject (unknown outcome) and the
//                                  side effect MUST NOT be replayed. Exit 0.
//
// The "no side-effect replay" proof is the side-effects.log line count staying at
// exactly 1 across both phases — a re-run would append a second line.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SessionStore, loadRecovery } from "@di/coding-agent";

const [, , mode, diHome, killPoint] = process.argv;

if (!mode || !diHome) {
  console.error("usage: host.mjs <run|resume|resume-unknown> <diHome> [killPoint]");
  process.exit(2);
}

const sideEffectsPath = join(diHome, "side-effects.log");
const readyPath = join(diHome, "phase1-ready.json");
const sessionPathPath = join(diHome, "session-path.json");
const donePath = join(diHome, "phase2-done.json");

const NOT_EXECUTED_NOTE =
  "Recovery note: this tool call was not executed before the checkpoint. Decide whether it is still needed.";

function sideEffectCount() {
  if (!existsSync(sideEffectsPath)) return 0;
  return readFileSync(sideEffectsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

function die(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function writeOutcome(outcome) {
  writeFileSync(donePath, JSON.stringify(outcome, null, 2));
}

function main() {
  if (mode === "run") {
    const store = new SessionStore({ rootDirectory: diHome });
    writeFileSync(sessionPathPath, JSON.stringify({ logFilePath: store.logFilePath, pid: process.pid }));
    store.startSession();
    store.beginCheckpointTurn("run deployment", Date.now(), []);

    if (killPoint === "after-started") {
      // One tool call; started marker + a real side effect, then the process dies
      // BEFORE the completed checkpoint is ever written.
      const call = { id: "c1", name: "deploy", arguments: '{"target":"prod"}' };
      store.appendCheckpointMessage({
        role: "assistant",
        content: [{ type: "text", text: "部署中" }, { type: "tool-call", id: call.id, name: call.name, arguments: call.arguments }],
      });
      store.checkpointToolStarted(call);
      appendFileSync(sideEffectsPath, `ran ${call.id} ${Date.now()}\n`);
      writeFileSync(readyPath, JSON.stringify({ pid: process.pid, killPoint }));
      // Park until the parent kills us (60s failsafe so a broken parent test
      // never hangs). The timer is NOT unref'd: it keeps the event loop alive so
      // the parent has time to force-kill the process tree.
      setTimeout(() => process.exit(0), 60_000);
      return;
    }

    // after-completed: two tool calls in one assistant batch; only c1 executes and
    // its result is checkpointed. c2 never starts (partial batch completes).
    const calls = [
      { id: "c1", name: "deploy", arguments: '{"target":"prod"}' },
      { id: "c2", name: "verify", arguments: '{"target":"prod"}' },
    ];
    store.appendCheckpointMessage({
      role: "assistant",
      content: [
        { type: "text", text: "部署并验证" },
        ...calls.map((c) => ({ type: "tool-call", id: c.id, name: c.name, arguments: c.arguments })),
      ],
    });
    store.checkpointToolStarted(calls[0]);
    appendFileSync(sideEffectsPath, `ran ${calls[0].id} ${Date.now()}\n`);
    store.checkpointToolCompleted({ role: "tool", toolCallId: "c1", content: "deployed ok", isError: false });
    store.completeCheckpointTurn({ stopReason: "answer", iterations: 1 });
    writeFileSync(readyPath, JSON.stringify({ pid: process.pid, killPoint }));
    setTimeout(() => process.exit(0), 60_000);
    return;
  }

  if (mode === "resume") {
    const { logFilePath } = JSON.parse(readFileSync(sessionPathPath, "utf8"));
    const trajectory = loadRecovery(logFilePath);
    const tools = trajectory.filter((m) => m.role === "tool");
    const c1Result = tools.find((m) => m.toolCallId === "c1");
    const c2Note = tools.find((m) => m.toolCallId === "c2");
    const count = sideEffectCount();
    let replayDetected = false;
    // Result preservation: the completed c1 result must be exactly as checkpointed.
    if (c1Result?.content !== "deployed ok") replayDetected = true;
    // The never-started c2 must be an explicit "not executed" note, never a fake result.
    if (c2Note === undefined || !c2Note.content.includes("not executed")) replayDetected = true;
    // No side-effect replay: c1 ran exactly once, in phase 1 only.
    if (count !== 1) replayDetected = true;
    const outcome = {
      recoveredRoles: trajectory.map((m) => m.role),
      c1Result: c1Result?.content ?? null,
      c2Note: c2Note?.content ?? null,
      sideEffectCount: count,
      replayDetected,
    };
    writeOutcome(outcome);
    if (replayDetected) die(`resume replay detected: ${JSON.stringify(outcome)}`);
    console.log("resume ok");
    process.exit(0);
  }

  if (mode === "resume-unknown") {
    const { logFilePath } = JSON.parse(readFileSync(sessionPathPath, "utf8"));
    const count = sideEffectCount();
    let rejected = false;
    let code = null;
    try {
      loadRecovery(logFilePath);
    } catch (error) {
      rejected = true;
      code = error?.code ?? String(error);
    }
    const replayDetected = count !== 1;
    const outcome = { rejected, code, sideEffectCount: count, replayDetected };
    writeOutcome(outcome);
    if (!rejected || !String(code).includes("unknown") || replayDetected) {
      die(`fail-closed violated: ${JSON.stringify(outcome)}`);
    }
    console.log("rejected ok");
    process.exit(0);
  }

  die(`unknown mode: ${mode}`);
}

main();
