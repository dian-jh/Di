import { performance } from "node:perf_hooks";

const STDERR_LIMIT = 4096;

/** Run a resume child to close, bounding timeout and reap waits. */
export function runResumeChild({
  spawn,
  args = [],
  options = { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  childState,
  timeoutMs = 120_000,
  killGraceMs = 5_000,
} = {}) {
  const startedAt = performance.now();
  let child;
  try {
    child = spawn(args, options);
  } catch (error) {
    return Promise.resolve({
      ok: false,
      spawned: false,
      closed: false,
      timedOut: false,
      parentMs: performance.now() - startedAt,
      handshakeMs: null,
      childMs: null,
      exitCode: null,
      message: `resume child spawn failed: ${messageOf(error)}`,
    });
  }

  return new Promise((resolve) => {
    let spawned = false;
    let closed = false;
    let settled = false;
    let timedOut = false;
    let exitCode = null;
    let childMs = null;
    let handshakeMs = null;
    let spawnError = null;
    let stdoutPending = "";
    let childFailure = "";
    let stderrText = "";
    let timeoutTimer;
    let killTimer;
    let finalTimer;

    const appendBounded = (current, text) => (current + text).slice(-STDERR_LIMIT);
    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(finalTimer);
    };
    const detachStreams = () => {
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
    };
    const cleanup = () => {
      clearTimers();
      detachStreams();
      if (closed) {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      }
    };
    const messageFor = () => {
      if (timedOut) return closed ? "resume child timed out" : "resume child timed out and did not close after kill";
      if (spawnError !== null) return `resume child error: ${messageOf(spawnError)}`;
      if (childFailure.length > 0) return childFailure;
      if (handshakeMs === null) return `resume child exited without RESUMED handshake${stderrText ? `: ${stderrText}` : ""}`;
      if (exitCode !== 0) return `resume child exit ${exitCode}${stderrText ? `: ${stderrText}` : ""}`;
      return "resume child failed";
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!closed) {
        try { child.stdout?.destroy(); } catch { /* best effort */ }
        try { child.stderr?.destroy(); } catch { /* best effort */ }
        try { child.unref?.(); } catch { /* best effort */ }
      }
      resolve({
        ok: closed && !timedOut && spawnError === null && childFailure.length === 0 && handshakeMs !== null && exitCode === 0,
        spawned,
        closed,
        timedOut,
        parentMs: performance.now() - startedAt,
        handshakeMs,
        childMs,
        exitCode,
        pid: child.pid ?? null,
        message: closed && !timedOut && spawnError === null && childFailure.length === 0 && handshakeMs !== null && exitCode === 0
          ? null
          : messageFor(),
      });
    };
    const onSpawn = () => {
      if (spawned) return;
      spawned = true;
      if (childState !== undefined) {
        childState.created += 1;
        childState.resumeCreated = (childState.resumeCreated ?? 0) + 1;
      }
    };
    const onClose = (code) => {
      if (closed) return;
      closed = true;
      exitCode = code;
      if (spawned && childState !== undefined) {
        childState.exited += 1;
        childState.resumeExited = (childState.resumeExited ?? 0) + 1;
      }
      settle();
    };
    const onError = (error) => {
      spawnError ??= error;
      if (!spawned && !settled) {
        // Failed spawn attempts still get a short chance to emit `close`.
        killTimer = setTimeout(() => settle(), killGraceMs * 2);
      }
    };
    const onStdout = (chunk) => {
      stdoutPending += chunk.toString("utf8");
      let newline;
      while ((newline = stdoutPending.indexOf("\n")) >= 0) {
        const line = stdoutPending.slice(0, newline).replace(/\r$/, "");
        stdoutPending = stdoutPending.slice(newline + 1);
        const resumed = /^RESUMED (\d+)(?:\s|$)/.exec(line);
        if (resumed !== null && handshakeMs === null) {
          childMs = Number(resumed[1]);
          handshakeMs = performance.now() - startedAt;
        } else if (line.startsWith("RESUME_FAIL")) {
          childFailure = appendBounded(childFailure, line);
        }
      }
      if (stdoutPending.length > STDERR_LIMIT) stdoutPending = stdoutPending.slice(-STDERR_LIMIT);
    };
    const onStderr = (chunk) => {
      stderrText = appendBounded(stderrText, chunk.toString("utf8"));
    };
    const onTimeout = () => {
      if (closed || settled) return;
      timedOut = true;
      try {
        child.kill();
      } catch {
        // Continue to the bounded reap deadline.
      }
      killTimer = setTimeout(() => {
        if (closed || settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // Continue to the final bounded deadline.
        }
        finalTimer = setTimeout(() => settle(), killGraceMs);
      }, killGraceMs);
    };

    child.on("spawn", onSpawn);
    child.once("close", onClose);
    child.on("error", onError);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    timeoutTimer = setTimeout(onTimeout, timeoutMs);
  });
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
