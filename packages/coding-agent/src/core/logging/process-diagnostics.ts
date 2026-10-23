/*
 * Process lifecycle diagnostic hook: the process runner emits bypass
 * `proc: start / running / timeout /
 * exited` diagnostic lines through this static hook. Default no-op, never
 * throws — the same "bypass observation" philosophy as the run log (it must
 * never affect the process it is watching).
 *
 * The event bus cannot reach inside tools (process-level details are not turn
 * lifecycle events), so this single-direction static hook avoids threading the
 * bus through Executor → ICoreTool → ProcessRunner. The host (composition
 * root wires it: `ProcessDiagnostics.log = (msg) => diLog.log(LogLevel.Info, msg)`.
 */
export type ProcessDiagnosticSink = (message: string) => void;

export class ProcessDiagnostics {
  /** Diagnostic line receiver (null = off). The sink must guard its own I/O (the run log already does). */
  static log: ProcessDiagnosticSink | null = null;
}
