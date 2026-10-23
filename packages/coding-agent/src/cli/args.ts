/*
 * CLI argument parsing — pure data mapping (string[] → CliArgs + diagnostics).
 * (the language-neutral
 * contract part of the CLI shell, see docs/cli.md §3.2). The parser does no I/O
 * and touches no console; the result is handed to `CliMode.resolve` to decide
 * the running mode. Rules:
 * - everything after `--` is positional (no flag parsing);
 * - value flags (--model/-m --provider --mode --thinking --resume --stats
 * --skill-eval) require a following token that does not start with `-`,
 * otherwise a "缺值" diagnostic is reported (pessimistic: never swallow a flag
 * as a value);
 * - --list-models optionally consumes the next non-flag token as a pattern;
 * - --mode validates its value domain (interactive / print / json / rpc);
 * - unknown flags are recorded in `unknownFlags` AND diagnosed as errors
 * (pessimistic: never silently ignored).
 */

export interface CliArgs {
  /** Positional args: the headless prompt (also anything after `--`). */
  readonly positionals: readonly string[];
  /** --model / -m: current model name. */
  readonly model: string | undefined;
  /** --provider: provider route. */
  readonly provider: string | undefined;
  /** --print: force text single-shot mode. */
  readonly print: boolean;
  /** --mode: explicit running mode (interactive / print / json / rpc). */
  readonly mode: string | undefined;
  /** --version: print version then exit. */
  readonly version: boolean;
  /** --info: print effective config / build / environment info then exit. */
  readonly info: boolean;
  /** --help / -h: print help then exit. */
  readonly help: boolean;
  /** --list-models [pattern]: "" when the flag is given without a pattern; null when the flag is absent. */
  readonly listModels: string | null;
  /** --stats <file>: aggregate one session JSONL. */
  readonly stats: string | undefined;
  /** --skill-eval <file>: evaluate the skill matcher on a labeled case set. */
  readonly skillEval: string | undefined;
  /** --thinking: reasoning effort (pass-through). */
  readonly thinking: string | undefined;
  /** --no-session: headless without a session log. */
  readonly noSession: boolean;
  /** --resume <file>: load a persisted trajectory and enter interactive mode. */
  readonly resume: string | undefined;
  /** --no-ansi: disable ANSI control sequences. */
  readonly noAnsi: boolean;
  /** Unknown flags kept verbatim (diagnosed as errors). */
  readonly unknownFlags: readonly string[];
}

/** One argument diagnostic; `isError` = the caller should exit non-zero. */
export interface CliDiagnostic {
  readonly message: string;
  readonly isError: boolean;
}

export interface CliArgsParseResult {
  readonly args: CliArgs;
  readonly diagnostics: readonly CliDiagnostic[];
}

const KNOWN_MODES = ["interactive", "print", "json", "rpc"] as const;

/*
 * Pure argument parser (Pi's `cli/args.ts` counterpart). Exact error strings
 * match the so any language rewrite produces the same observable
 * output.
 */
export const CliArgsParser = {
  parse(args: readonly string[]): CliArgsParseResult {
    const positionals: string[] = [];
    const unknown: string[] = [];
    const diagnostics: CliDiagnostic[] = [];
    let model: string | undefined;
    let provider: string | undefined;
    let mode: string | undefined;
    let thinking: string | undefined;
    let resume: string | undefined;
    let listModels: string | null = null;
    let stats: string | undefined;
    let skillEval: string | undefined;
    let print = false;
    let version = false;
    let info = false;
    let help = false;
    let noSession = false;
    let noAnsi = false;
    let afterDoubleDash = false;

    for (let i = 0; i < args.length; i += 1) {
      const token = args[i]!;

      if (afterDoubleDash) {
        positionals.push(token);
        continue;
      }

      switch (token) {
        case "--":
          afterDoubleDash = true;
          break;

        case "--version":
          version = true;
          break;

        case "--info":
          info = true;
          break;

        case "-h":
        case "--help":
          help = true;
          break;

        case "--print":
          print = true;
          break;

        case "--no-session":
          noSession = true;
          break;

        case "--no-ansi":
          noAnsi = true;
          break;

        case "--resume": {
          const r = takeValue(args, i, "--resume", diagnostics);
          if (r.value !== undefined) resume = r.value;
          i = r.nextIndex;
          break;
        }

        case "-m":
        case "--model": {
          const r = takeValue(args, i, "--model", diagnostics);
          if (r.value !== undefined) model = r.value;
          i = r.nextIndex;
          break;
        }

        case "--provider": {
          const r = takeValue(args, i, "--provider", diagnostics);
          if (r.value !== undefined) provider = r.value;
          i = r.nextIndex;
          break;
        }

        case "--thinking": {
          const r = takeValue(args, i, "--thinking", diagnostics);
          if (r.value !== undefined) thinking = r.value;
          i = r.nextIndex;
          break;
        }

        case "--mode": {
          const r = takeValue(args, i, "--mode", diagnostics);
          if (r.value !== undefined) {
            mode = r.value;
            if (!KNOWN_MODES.some((m) => m === r.value)) {
              diagnostics.push({
                message: `未知模式: --mode ${r.value}（可选 interactive / print / json / rpc）`,
                isError: true,
              });
            }
          }
          i = r.nextIndex;
          break;
        }

        case "--list-models":
          listModels = "";
          // Optional pattern: only consume the next token when it does not start
          // with '-', so other flags are never swallowed as a pattern.
          if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
            listModels = args[i + 1]!;
            i += 1;
          }
          break;

        case "--stats": {
          const r = takeValue(args, i, "--stats", diagnostics);
          if (r.value !== undefined) stats = r.value;
          i = r.nextIndex;
          break;
        }

        case "--skill-eval": {
          const r = takeValue(args, i, "--skill-eval", diagnostics);
          if (r.value !== undefined) skillEval = r.value;
          i = r.nextIndex;
          break;
        }

        default:
          if (token.startsWith("-")) {
            unknown.push(token);
            diagnostics.push({ message: `未知选项: ${token}（--help 查看用法）`, isError: true });
          } else {
            positionals.push(token);
          }
          break;
      }
    }

    return {
      args: {
        positionals,
        model,
        provider,
        print,
        mode,
        version,
        info,
        help,
        listModels,
        stats,
        skillEval,
        thinking,
        noSession,
        resume,
        noAnsi,
        unknownFlags: unknown,
      },
      diagnostics,
    };
  },
};

/**
 * Take the next token as the flag's value. Missing value (end of args) or a
 * following flag reports "缺值" (pessimistic: a flag is never swallowed as a
 * value). `nextIndex` is `i` when no value was taken so the caller keeps the
 * current token for its own switch handling.
 */
function takeValue(
  args: readonly string[],
  i: number,
  flag: string,
  diagnostics: CliDiagnostic[],
): { value: string | undefined; nextIndex: number } {
  if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
    return { value: args[i + 1], nextIndex: i + 1 };
  }
  diagnostics.push({ message: `选项 ${flag} 缺少值`, isError: true });
  return { value: undefined, nextIndex: i };
}
