import { parentPort } from "node:worker_threads";

/*
 * Regex worker for the grep tool.
 *
 * Each bounded regex job runs on a dedicated worker thread:
 * a synchronous JS regex cannot be interrupted on the main thread (probe
 * experiment B froze the whole event loop), so a pathological
 * (catastrophic-backtracking) pattern must live on a thread the parent can
 * `worker.terminate`. The parent keeps one worker per grep call, posts a job
 * per file, and terminates/rebuilds it on timeout or abort.
 *
 * The worker compiles the RegExp once per job and tests it against the batch of
 * lines, posting back 1-based hit line numbers — matching happens here, never on
 * the loop thread.
 */

export interface RegexJob {
  readonly pattern: string;
  readonly flags: string;
  readonly lines: readonly string[];
}

export interface RegexJobResult {
  readonly ok: true;
  readonly hits: readonly number[];
}

interface RegexJobError {
  readonly ok: false;
  readonly error: string;
}

parentPort!.on("message", (job: RegexJob) => {
  let hits: number[] = [];
  try {
    const regex = new RegExp(job.pattern, job.flags);
    const { lines } = job;
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i]!)) hits.push(i + 1);
    }
    const result: RegexJobResult = { ok: true, hits };
    parentPort!.postMessage(result);
  } catch (error) {
    const result: RegexJobError = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    parentPort!.postMessage(result);
  }
});
