/*
 * Session format / recovery state-machine failure classes.
 *
 * 状态机与错误处理": the migration must normalize the 's low-level
 * `GetProperty` exceptions into line-numbered `InvalidData`-style errors, reject
 * unknown top-level/checkpoint records (never skip them as audit noise), and fail
 * closed on any started tool whose outcome is unknown. Codes map 1:1 to the
 * fixture manifest `expected_error_class` values.
 */

/** Stable machine-readable session failure classes. */
export type SessionErrorCode =
  /** Invalid JSON, missing/mistyped fields, orphan/duplicate records, mismatched result. */
  | "corrupt"
  /** Unknown top-level or checkpoint record type (state evidence — never skipped). */
  | "unknown-record"
  /** Unknown checkpoint content block type (never dropped, never auto-executed). */
  | "unknown-block"
  /** A started tool has no durable completed outcome — replay is forbidden. */
  | "unknown-outcome"
  /** Legacy/audit-only log with no recovery checkpoint. */
  | "no-checkpoint"
  /** The writer refused a block/message it cannot serialize (never writes `{type:"unknown"}`). */
  | "cannot-serialize";

/** Base error for session format failures, recovery rejections and writer refusals. */
export class SessionDataError extends Error {
  readonly code: SessionErrorCode;
  /** Physical line number (1-based) when the failure is tied to a record; undefined otherwise. */
  readonly lineNumber: number | undefined;
  /** The offending record/block type when one exists. */
  readonly recordType: string | undefined;

  constructor(
    code: SessionErrorCode,
    message: string,
    options: { lineNumber?: number; recordType?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SessionDataError";
    this.code = code;
    this.lineNumber = options.lineNumber;
    this.recordType = options.recordType;
  }
}
