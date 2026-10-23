import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DiHome } from "../config/di-home.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { LogEvent } from "../events/log-events.ts";

/*
 * Per-day lifecycle log (, jcode format
 * per docs/modules/logging.md): one `di-YYYY-MM-DD.log` per day (LOCAL-time
 * naming, daily rotation) under `RootDirectory/logs/`; one event per line for
 * the turn lifecycle (run / llm / tool lines); long fields folded + truncated
 * (never wrap, readable summary); verbatim streams (raw model output / full
 * tool output) NEVER written here — the full text lives only in the session
 * JSONL; slow-process/timeout diagnostics arrive via the ProcessDiagnostics
 * static hook; `di starting` (host) via {@link log}; `di exiting` + file close
 * on {@link dispose}.
 *
 * TWO INDEPENDENT failure paths (must never share a swallow-exception write
 * helper):
 * - log I/O failure → silent drop of the current line, NEVER throws, NEVER
 * affects the main flow (the log is a bypass observation);
 * - the checkpoint/session-store path stays fail-closed (a failed checkpoint
 * write aborts the loop before unstarted side effects —, tested in
 * @di/agent) — DiLog has no access to it and never touches it.
 *
 * Lines NEVER contain sensitive fields: `redactSensitive` runs on every line
 * (event fields, `log` messages and proc diagnostics), so token /
 * Authorization / Cookie values never reach the log.
 */
export const LogLevel = { Info: "INFO", Warn: "WARN", Error: "ERROR" } as const;
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/** Run-log configuration. */
export interface DiLogOptions {
  /** Log root directory; `RootDirectory/logs/` holds one file per day (defaults to DiHome). */
  rootDirectory?: string;
  /** Clock (LOCAL time): line timestamps + the daily-rotation date key; tests inject a fake clock. */
  clock?: () => Date;
}

/** Single-field display cap: a long text collapsed then truncated at 300 chars (full text lives in the session JSONL). */
const MAX_FIELD_LENGTH = 300;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** `yyyy-MM-dd` date key in LOCAL time — the rotation key and the filename date. */
function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** `yyyy-MM-dd HH:mm:ss.fff` local-time line timestamp (jcode format). */
function formatTimestamp(date: Date): string {
  return `${dateKey(date)} ${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * Fold runs of whitespace / multi-line text into a single line, then truncate
 * fields over MAX_FIELD_LENGTH with a trailing `…` — the log is a scannable
 * timeline only; the verbatim text lives in the session JSONL.
 */
function collapse(text: string): string {
  const collapsed = text.split(/\s+/).filter((part) => part.length > 0).join(" ");
  return collapsed.length <= MAX_FIELD_LENGTH ? collapsed : `${collapsed.slice(0, MAX_FIELD_LENGTH)}…`;
}

/**
 * Redact sensitive fields so the run log NEVER contains credentials:
 * header-style `Authorization: …` / `Cookie: …` (value masked to end of
 * line/comma/semicolon) and token/key/secret/password parameters
 * (`token=…`, `api_key=…`, `password=…`) plus bare `Bearer <value>`. Applied
 * BEFORE folding so a value with internal spaces is fully masked. Runs on every
 * line (event fields, `log()` and proc diagnostics).
 */
export function redactSensitive(text: string): string {
  let result = text;
  result = result.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[=:]\s*[^\r\n,;]+/gi,
    (_match, key: string) => `${key}:***`,
  );
  result = result.replace(
    /\b(access[_-]?token|auth[_-]?token|api[_-]?key|apikey|password|passwd|secret|client[_-]?secret|session[_-]?token|token)\s*[=:]\s*["']?[^\s"';,]+/gi,
    (_match, key: string) => `${key}=***`,
  );
  result = result.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "bearer ***");
  return result;
}

/** The completed model-call line: iteration + duration + usage + cost + finish reason. */
function buildCompletedLine(event: Extract<LogEvent, { type: "turnCompleted" }>): string {
  const parts = [
    `llm: call_completed iteration=${event.iteration}`,
    `tokens_in=${event.usage.inputTokens}`,
    `tokens_out=${event.usage.outputTokens}`,
    `cache_read=${event.usage.cacheReadTokens ?? 0}`,
  ];
  if (event.cost !== undefined) {
    const total = event.cost.input + event.cost.output + event.cost.cacheRead + event.cost.cacheWrite;
    parts.push(`cost=${total.toFixed(4)}`);
  }
  parts.push(`finish=${event.finishReason.type}`);
  return parts.join(" ");
}

/**
 * The run log sink. Constructing with an unwritable root enters a silent
 * fallback (all writes become no-ops); I/O failures are always dropped, never
 * thrown. `subscribe(bus)` is idempotent; `dispose()` writes `di exiting`,
 * closes the file and unsubscribes (also idempotent).
 */
export class DiLog {
  private readonly options_: Required<DiLogOptions>;
  private writer_: number | null = null; // open fd (append mode)
  private fileKey_: string | null = null; // date key of the currently open file (yyyy-MM-dd)
  private unsubscribe_: (() => void) | null = null;
  /** Last in-flight model call (single-slot duration tracking): read-and-clear on completion. */
  private lastModelCall_: { iteration: number; startedAt: Date } | null = null;
  private disposed_ = false;

  constructor(options?: DiLogOptions) {
    this.options_ = {
      rootDirectory: options?.rootDirectory ?? DiHome.fromEnvironment(process.env, homedir()).rootDirectory,
      clock: options?.clock ?? (() => new Date()),
    };
    try {
      this.openWriter(this.options_.clock());
    } catch {
      // Directory / file open failure: enter silent fallback; all writes become no-ops.
    }
  }

  /** Subscribe on the event bus and translate lifecycle events into log lines. Idempotent. */
  subscribe(bus: EventBus): void {
    if (bus == null) throw new TypeError("DiLog.subscribe: bus is required");
    if (this.unsubscribe_ !== null) return;
    this.unsubscribe_ = bus.subscribeWith((event: LogEvent) => this.handle(event));
  }

  /** Write one jcode line (host lines like `di starting pid=… workspace=…`; proc lines come via ProcessDiagnostics). */
  log(level: LogLevel, message: string): void {
    if (message == null) throw new TypeError("DiLog.log: message is required");
    this.writeLine(level, message, null);
  }

  /** Write `di exiting`, flush, close the file, unsubscribe. Idempotent. */
  dispose(): void {
    if (this.disposed_) return;
    this.disposed_ = true;

    this.unsubscribe_?.();
    this.unsubscribe_ = null;

    // The exit line goes through the unguarded core (writeLine's disposed guard
    // would drop it); rotation / write failures inside are swallowed.
    this.writeLineCore(LogLevel.Info, "di exiting", null);
    if (this.writer_ !== null) {
      try {
        closeSync(this.writer_);
      } catch {
        // File already gone: nothing left to close.
      }
      this.writer_ = null;
    }
  }

  /** Event → log line. Verbatim stream increments (TextDelta/ReasoningDelta/ToolCallDelta) are skipped. */
  private handle(event: LogEvent): void {
    switch (event.type) {
      case "runStarted":
        this.writeLine(LogLevel.Info, `run: started user_input=${collapse(redactSensitive(event.userMessage))}`, null);
        break;
      case "modelCallStarted":
        this.lastModelCall_ = { iteration: event.iteration, startedAt: this.options_.clock() };
        this.writeLine(LogLevel.Info, `llm: call_started iteration=${event.iteration}`, null);
        break;
      case "turnCompleted":
        this.writeLine(LogLevel.Info, buildCompletedLine(event), this.takeDuration());
        break;
      case "runFailed":
        this.writeLine(
          LogLevel.Error,
          `llm: run_failed code=${event.failure.code} error=${collapse(redactSensitive(event.failure.message))}`,
          this.takeDuration(),
        );
        break;
      case "toolStarted":
        this.writeLine(LogLevel.Info, `tool: started name=${event.call.name}`, null);
        break;
      case "toolCompleted":
        if (event.isError) {
          this.writeLine(
            LogLevel.Warn,
            `tool: failed name=${event.call.name} error=${collapse(redactSensitive(event.observation))}`,
            null,
          );
        } else {
          this.writeLine(LogLevel.Info, `tool: completed name=${event.call.name}`, null);
        }
        break;
      case "interrupted":
        this.writeLine(LogLevel.Info, "run: interrupted", null);
        break;
      default:
        // textDelta / reasoningDelta / toolCallDelta: verbatim stream noise —
        // skipped (full text lives only in the session JSONL).
        break;
    }
  }

  /**
   * Duration of the in-flight model call (ms, wall-clock difference read at the
   * completing event): read-and-clear the single slot; none in flight → null.
   * TS events carry no CreatedAt timestamps, so the completing event is measured
   * at handle time (divergence from ).
   */
  private takeDuration(): number | null {
    const call = this.lastModelCall_;
    if (call === null) return null;
    this.lastModelCall_ = null;
    return Math.max(0, this.options_.clock().getTime() - call.startedAt.getTime());
  }

  /** Write one line: guarded (disposed / no writer → drop), daily rotation, per-line flush. */
  private writeLine(level: LogLevel, message: string, durationMs: number | null): void {
    if (this.disposed_ || this.writer_ === null) return;
    this.writeLineCore(level, message, durationMs);
  }

  /** Write-line core (caller already gated; no guard): rotate + format + write. I/O failure silently drops the line. */
  private writeLineCore(level: LogLevel, message: string, durationMs: number | null): void {
    const now = this.options_.clock();
    // Daily rotation: when the date key changes, reopen the file (compared
    // BEFORE writing so the first line of a new day lands in the right file).
    const key = dateKey(now);
    if (key !== this.fileKey_) {
      try {
        this.openWriter(now);
      } catch {
        return; // Rotation failure: drop this line, retry on the next line.
      }
    }
    const fd = this.writer_;
    if (fd === null) return;

    let line = `[${formatTimestamp(now)}] [${level}] ${redactSensitive(message)}`;
    if (durationMs !== null) line += ` duration_ms=${durationMs}`;
    line = line.trimEnd();

    try {
      writeSync(fd, `${line}\n`);
    } catch {
      // Write failure (disk full / file deleted): drop this line. The next line
      // still attempts — no retry storm, no throw.
    }
  }

  /** Open (or reopen on rotation) today's file. Caller handles a thrown failure. */
  private openWriter(now: Date): void {
    if (this.writer_ !== null) {
      try {
        closeSync(this.writer_);
      } catch {
        // Old fd already gone.
      }
      this.writer_ = null;
    }
    const key = dateKey(now);
    const dir = join(this.options_.rootDirectory, "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `di-${key}.log`);
    this.writer_ = openSync(file, "a");
    this.fileKey_ = key;
  }
}
