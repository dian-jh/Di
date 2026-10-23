import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 *
 * (`CliApp → createCliHost → loadRecovery → restoreHistory → RPC ready`), NOT a
 * test host / fake runner / direct loadRecovery call.
 *
 * Scenario U (unknown-outcome → fail-closed): production via `--mode rpc` with an
 * empty DEEPSEEK_API_KEY writes a session that is "checkpoint_turn_started, no
 * completion, no started tool" (the model throws MISSING_CREDENTIAL BEFORE any
 * request, so no tool ever runs); a restart of that produced file must fail
 * closed (exit 1, a single JSON error doc on stdout — never an empty session).
 * The deterministic unknown-outcome envelope (`session_resume`) is re-verified
 * with the committed fixture `started-no-completion.jsonl` (a started tool with
 * no completed outcome → loadRecovery rejects).
 *
 * Scenario C (completed → restart): a completed session is produced with the
 * REAL SessionStore (fixture test/cli/fixtures/produce-completed-session.mjs:
 * c1 = write_file writes a real side-effect file, c2 never starts, c1 result
 * checkpointed, turn completed). Restart through `--mode rpc --resume <file>`:
 * the ready handshake proves loadRecovery + restoreHistory wired correctly; a
 * "continue" turn fails on the model, but beginCheckpointTurn has already
 * snapshotted the restored history — the c1 tool RESULT is reused verbatim and
 * c2 carries the explicit "not executed" recovery note — and the side-effect
 * file stays at exactly 1 line (no replay).
 *
 * Independent child processes, isolated temp DI_HOME, synthetic credentials only
 * (DEEPSEEK_API_KEY forced empty) — NEVER real API.
 */

const node = process.execPath;
const cwd = process.cwd();
const entry = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const unknownFixture = fileURLToPath(
  new URL("../fixtures/sessions/started-no-completion/started-no-completion.jsonl", import.meta.url),
);
const produceFixture = fileURLToPath(
  new URL("../cli/fixtures/produce-completed-session.mjs", import.meta.url),
);

/** A line reader over a stdout/stderr stream with a per-line budget. */
interface LineReader {
  nextLine(budgetMs: number): Promise<string | null>;
}

function createLineReader(stream: NodeJS.ReadableStream): LineReader {
  let buffer = "";
  let ended = false;
  const waiters: Array<(line: string | null) => void> = [];
  stream.setEncoding("utf8");

  const onData = (chunk: string): void => {
    buffer += chunk;
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (waiters.length > 0) waiters.shift()!(line);
    }
  };
  const onEnd = (): void => {
    ended = true;
    while (waiters.length > 0) waiters.shift()!(null);
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  stream.on("close", onEnd);

  return {
    nextLine(budgetMs: number): Promise<string | null> {
      return new Promise((resolve) => {
        const nl = buffer.indexOf("\n");
        if (nl >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          resolve(line);
          return;
        }
        if (ended) {
          resolve(null);
          return;
        }
        const worker = (line: string | null): void => {
          clearTimeout(timer);
          resolve(line);
        };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(worker);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve(null);
        }, budgetMs);
        waiters.push(worker);
      });
    },
  };
}

/** Read NDJSON lines until one parses with `type === kind` (returns it) or the budget expires (null). */
async function readUntilType(
  reader: LineReader,
  kind: string,
  budgetMs: number,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + budgetMs;
  while (true) {
    const line = await reader.nextLine(Math.max(1_000, deadline - Date.now()));
    if (line === null) return null;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (doc["type"] === kind) return doc;
  }
}

/** Wait for the child to exit (or fail); kills it on budget expiry. */
function waitExit(
  child: ChildProcess,
  budgetMs: number,
): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child did not exit within ${budgetMs}ms`));
    }, budgetMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, error });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
}

/** Run a one-shot child to completion, collecting stdout/stderr. Ends stdin immediately when asked. */
function spawnCollect(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { cwd?: string; endStdin?: boolean; budgetMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(node, args as string[], {
      cwd: options.cwd ?? cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => (stdout += chunk));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`one-shot child did not exit within ${options.budgetMs ?? 30_000}ms`));
    }, options.budgetMs ?? 30_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (options.endStdin === true) {
      try {
        child.stdin!.end();
      } catch {
        // the child already exited; nothing to close
      }
    }
  });
}

// ---- session-file helpers (field-level assertions, never "no throw / non-null") ----

function listSessionFiles(diHome: string): string[] {
  const root = join(diHome, "sessions");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out;
}

function parseSessionLines(path: string): Array<Record<string, any>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function envelopes(envs: Array<Record<string, any>>, type: string): Array<Record<string, any>> {
  return envs.filter((e) => e["type"] === type);
}

function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

function rpcEnv(options: { diHome: string }): NodeJS.ProcessEnv {
  return { DI_HOME: options.diHome, DEEPSEEK_API_KEY: "" };
}

// ===========================================================================
// Scenario U — unknown-outcome → fail-closed
// ===========================================================================

test("P7b-3 scenario U: production — model fails before any request, session is 'started, no completion', exit 0", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-crash-u-"));
  const child = spawn(node, [entry, "--mode", "rpc"], {
    cwd,
    env: rpcEnv({ diHome }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    const stdout = createLineReader(child.stdout!);
    const ready = await readUntilType(stdout, "ready", 20_000);
    assert.ok(ready !== null, "the ready handshake must arrive (CLI starts fine without a key)");
    assert.equal(ready["type"], "ready");

    child.stdin!.write(JSON.stringify({ method: "prompt", params: { message: "hello" } }) + "\n");

    const result = await readUntilType(stdout, "result", 30_000);
    assert.ok(result !== null, "the failed turn must emit a result line");
    const r = result["result"] as Record<string, any>;
    assert.equal(r["stop_reason"], "error", "MISSING_CREDENTIAL before the request becomes stop_reason 'error'");
    assert.equal(r["failure"]?.["code"], "model_error", "RPC digests the failure as model_error");
    assert.ok(
      String(r["failure"]?.["message"]).includes("API Key"),
      `failure message names the missing credential, got: ${r["failure"]?.["message"]}`,
    );

    child.stdin!.write(JSON.stringify({ method: "shutdown", params: {} }) + "\n");
    child.stdin!.end();
    const { code, error } = await waitExit(child, 20_000);
    assert.equal(error, undefined, `child must shut down cleanly (${error ?? ""})`);
    assert.equal(code, 0, "clean shutdown exits 0");

    // ---- produced session file: exactly one, field-level state ----
    const files = listSessionFiles(diHome);
    assert.equal(files.length, 1, `exactly one session file produced, got ${files.join(", ")}`);
    const envs = parseSessionLines(files[0]!);
    const started = envelopes(envs, "checkpoint_turn_started");
    assert.equal(started.length, 1, "beginCheckpointTurn was written before the model call");
    assert.equal(envelopes(envs, "checkpoint_turn_completed").length, 0, "the turn never completed");
    assert.equal(envelopes(envs, "checkpoint_tool_started").length, 0, "no tool started (model failed pre-request)");
    assert.equal(envelopes(envs, "checkpoint_tool_completed").length, 0, "no tool result written");
    const user = started[0]!["payload"]?.["user"] as Record<string, any>;
    assert.equal(user?.["role"], "user", "the checkpoint carries the user message");
    assert.equal(user?.["blocks"]?.[0]?.["type"], "text");
    assert.equal(user?.["blocks"]?.[0]?.["text"], "hello", "the user prompt is snapshot verbatim");
    const failed = envelopes(envs, "event_msg").some((e) => e["payload"]?.["type"] === "task_failed");
    assert.ok(failed, "the failed turn leaves an audit failure trace");
    console.log(`scenario-U produced session: ${files[0]}`);
  } finally {
    child.kill();
    rmSync(diHome, { recursive: true, force: true });
  }
});

test("P7b-3 scenario U: restart of a produced 'started, no completion' session fails closed (exit 1, single JSON error doc, never an empty session)", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-crash-u-"));
  let producedFile: string | undefined;
  try {
    // ---- reproduce the production chain (real CLI rpc, empty key) ----
    const child = spawn(node, [entry, "--mode", "rpc"], {
      cwd,
      env: rpcEnv({ diHome }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    try {
      const stdout = createLineReader(child.stdout!);
      assert.ok((await readUntilType(stdout, "ready", 20_000)) !== null, "ready handshake expected");
      child.stdin!.write(JSON.stringify({ method: "prompt", params: { message: "hello" } }) + "\n");
      assert.ok((await readUntilType(stdout, "result", 30_000)) !== null, "error result expected");
      child.stdin!.write(JSON.stringify({ method: "shutdown", params: {} }) + "\n");
      child.stdin!.end();
      const { code, error } = await waitExit(child, 20_000);
      assert.equal(error, undefined, `production child must exit cleanly (${error ?? ""})`);
      assert.equal(code, 0);
    } finally {
      child.kill();
    }
    const files = listSessionFiles(diHome);
    assert.equal(files.length, 1, "production writes exactly one session file");
    producedFile = files[0];

    // ---- restart through the REAL CLI json mode, stdin EOF (no prompt) ----
    const restart = await spawnCollect(
      [entry, "--mode", "json", "--resume", producedFile!],
      rpcEnv({ diHome }),
      { endStdin: true, budgetMs: 30_000 },
    );
    assert.equal(restart.code, 1, `restart must exit 1 (fail closed), stdout=${restart.stdout}`);
    const doc = JSON.parse(restart.stdout) as Record<string, any>;
    assert.ok(doc["error"], "restart emits a single JSON error doc, never an empty session");
    assert.equal(typeof doc["error"]["code"], "string", "the error carries an explicit code");
    assert.ok(!("answer" in doc), "an empty session is never started");
    console.log(`scenario-U produced-file restart: exit=${restart.code} error.code=${doc["error"]["code"]}`);
  } finally {
    rmSync(diHome, { recursive: true, force: true });
  }
});

test("P7b-3 scenario U: unknown-outcome fixture restarts through the real CLI json mode → session_resume envelope, exit 1", async () => {
  const diHome = mkdtempSync(join(tmpdir(), "di-crash-u-"));
  try {
    // started-no-completion.jsonl has a checkpoint_tool_started (call-01 read_file)
    // with no durable completed outcome → loadRecovery rejects (unknown-outcome),
    // createCliHost throws, json mode writes the session_resume envelope, exit 1.
    const restart = await spawnCollect(
      [entry, "--mode", "json", "--resume", unknownFixture],
      rpcEnv({ diHome }),
      { endStdin: true, budgetMs: 30_000 },
    );
    assert.equal(restart.code, 1, `unknown-outcome restart must exit 1, stdout=${restart.stdout}`);
    const doc = JSON.parse(restart.stdout) as Record<string, any>;
    assert.ok(doc["error"], "single JSON error doc expected");
    assert.equal(doc["error"]["code"], "session_resume", "the fail-closed resume envelope code");
    assert.ok(String(doc["error"]["message"]).includes("unknown"), `message names the unknown outcome: ${doc["error"]["message"]}`);
    assert.ok(!("answer" in doc), "an empty session is never started");
    console.log(`scenario-U fixture restart: exit=${restart.code} error.code=${doc["error"]["code"]}`);
  } finally {
    rmSync(diHome, { recursive: true, force: true });
  }
});

// ===========================================================================
// Scenario C — completed → kill → restart: reuse the checkpointed result, no replay
// ===========================================================================

test("P7b-3 scenario C: completed session restarts through the real CLI, reuses the c1 result and c2 note, side effect runs exactly once", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "di-crash-c-ws-"));
  const diHome = mkdtempSync(join(tmpdir(), "di-crash-c-home-"));
  const marker = join(diHome, "marker.json");
  const sideFile = join(workspace, "side-effects.log");
  try {
    // ---- production: the fixture writes a COMPLETED session with a real side effect ----
    const prod = await spawnCollect([produceFixture, workspace, diHome, marker], {}, { budgetMs: 30_000 });
    assert.equal(prod.code, 0, `fixture must produce the completed session: ${prod.stdout} ${prod.stderr}`);
    const { logFilePath } = JSON.parse(readFileSync(marker, "utf8")) as { logFilePath: string };
    assert.ok(existsSync(logFilePath), `produced session file must exist: ${logFilePath}`);
    assert.equal(countLines(sideFile), 1, "production executes write_file c1 exactly once");

    // field-level state of the PRODUCED (completed) session
    const prodEnvs = parseSessionLines(logFilePath);
    const prodCompleted = envelopes(prodEnvs, "checkpoint_turn_completed");
    assert.equal(prodCompleted.length, 1, "completeCheckpointTurn was written");
    assert.equal(prodCompleted[0]!["payload"]?.["stop_reason"], "answer");
    const prodStarted = envelopes(prodEnvs, "checkpoint_tool_started");
    assert.equal(prodStarted.length, 1, "only c1 started");
    assert.equal(prodStarted[0]!["payload"]?.["call_id"], "c1");
    assert.equal(prodStarted[0]!["payload"]?.["name"], "write_file", "the real write_file tool name");
    const prodCompletedTool = envelopes(prodEnvs, "checkpoint_tool_completed");
    assert.equal(prodCompletedTool.length, 1, "c1 result checkpointed");
    assert.equal(prodCompletedTool[0]!["payload"]?.["call_id"], "c1");
    assert.equal(
      prodCompletedTool[0]!["payload"]?.["message"]?.["text"],
      "OK: 已写入 7 字符到 side-effects.log",
      "the durable c1 result is the write_file observation",
    );

    // ---- restart: REAL CLI rpc --resume (empty key) ----
    const child = spawn(node, [entry, "--mode", "rpc", "--resume", logFilePath], {
      cwd: workspace,
      env: rpcEnv({ diHome }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    try {
      const stdout = createLineReader(child.stdout!);
      const ready = await readUntilType(stdout, "ready", 20_000);
      assert.ok(ready !== null, "the ready handshake must arrive — createCliHost = loadRecovery + restoreHistory succeeded");
      assert.equal(ready["type"], "ready");

      child.stdin!.write(JSON.stringify({ method: "prompt", params: { message: "continue" } }) + "\n");
      const result = await readUntilType(stdout, "result", 30_000);
      assert.ok(result !== null, "the continue turn must emit a result line");
      const r = result["result"] as Record<string, any>;
      assert.equal(r["stop_reason"], "error", "the empty-key model fails the resumed turn");
      assert.equal(r["failure"]?.["code"], "model_error");
      assert.ok(String(r["failure"]?.["message"]).includes("API Key"), "MISSING_CREDENTIAL before any request");

      child.stdin!.write(JSON.stringify({ method: "shutdown", params: {} }) + "\n");
      child.stdin!.end();
      const { code, error } = await waitExit(child, 20_000);
      assert.equal(error, undefined, `restart child must shut down cleanly (${error ?? ""})`);
      assert.equal(code, 0, "clean shutdown exits 0");
    } finally {
      child.kill();
    }

    // ---- field-level assertions on the resumed turn's checkpoint snapshot ----
    const files = listSessionFiles(diHome);
    const restartFile = files.find((f) => f !== logFilePath);
    assert.ok(restartFile !== undefined, `restart must write its own session file; saw ${files.join(", ")}`);
    const restartEnvs = parseSessionLines(restartFile!);
    const resumedStarted = envelopes(restartEnvs, "checkpoint_turn_started");
    assert.equal(resumedStarted.length, 1, "the resumed 'continue' turn snapshotted history before the model call");
    const history = resumedStarted[0]!["payload"]?.["history"] as Array<Record<string, any>> | undefined;
    assert.ok(Array.isArray(history), "the checkpoint history snapshot is present");

    // c1 result REUSED verbatim (not re-run, not fabricated)
    const c1 = history!.find((m) => m["role"] === "tool" && m["call_id"] === "c1");
    assert.ok(c1 !== undefined, "history reuses the checkpointed c1 tool result");
    assert.equal(c1!["text"], "OK: 已写入 7 字符到 side-effects.log", "the completed c1 result is preserved");
    assert.equal(c1!["is_error"], false);

    // c2 carried the explicit "not executed" recovery note
    const c2 = history!.find((m) => m["role"] === "tool" && m["call_id"] === "c2");
    assert.ok(c2 !== undefined, "history carries the never-started c2 note");
    assert.ok(
      String(c2!["text"]).includes("not executed"),
      `c2 is the recovery note, not a fabricated result: ${c2!["text"]}`,
    );

    // the assistant batch retains both tool calls (ids c1,c2)
    const assistant = history!.find((m) => m["role"] === "assistant");
    assert.ok(assistant !== undefined, "the assistant tool-call batch is in the snapshot");
    const calls = (assistant!["blocks"] as Array<Record<string, any>>).filter((b) => b["type"] === "tool_call");
    assert.deepEqual(
      calls.map((c) => c["id"]),
      ["c1", "c2"],
      "both tool calls are present in the snapshot",
    );
    assert.deepEqual(calls.map((c) => c["name"]), ["write_file", "write_file"]);

    // the resumed checkpoint's user is "continue"
    const user = resumedStarted[0]!["payload"]?.["user"] as Record<string, any>;
    assert.equal(user?.["blocks"]?.[0]?.["text"], "continue");

    // no tool ran during the restart
    assert.equal(envelopes(restartEnvs, "checkpoint_tool_started").length, 0, "no tool started on restart");
    assert.equal(envelopes(restartEnvs, "checkpoint_tool_completed").length, 0, "no tool result written on restart");

    // Side-effect sanity check: the file still holds its single production line.
    // NOTE: write_file is OVERWRITE ("never append", write.ts) — if c1 were
    // replayed with the identical content, the line count would still be 1, so
    // this count alone has no discriminative power for a same-content replay.
    // The actual no-replay evidence is the field-level assertions above: the
    // restart session file has ZERO checkpoint_tool_started / checkpoint_tool_completed
    // (no tool ever ran on restart), the c1 result is reused verbatim from the
    // checkpoint, and c2 is the explicit "not executed" recovery note.
    assert.equal(countLines(sideFile), 1, "the side-effect file holds the single production line (see comment: write_file overwrites, count alone is not replay evidence)");
    console.log(`scenario-C produced session: ${logFilePath}`);
    console.log(`scenario-C restart session: ${restartFile}`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(diHome, { recursive: true, force: true });
  }
});
