import type { CliArgs } from "./args.ts";

/*
 * CLI running modes (AppMode; Pi's
 * AppMode counterpart). `interactive` is the REPL, `print`/`json`/`rpc` are the
 * headless single-shot / protocol modes, and the rest are non-interactive
 * short paths. A string-valued const object (erasable TS — no runtime `enum`,
 * which Node type stripping would reject).
 */
export const AppMode = {
  Interactive: "interactive",
  Print: "print",
  Json: "json",
  Rpc: "rpc",
  Version: "version",
  Info: "info",
  Help: "help",
  ListModels: "list-models",
  Stats: "stats",
  SkillEval: "skill-eval",
} as const;

export type AppMode = (typeof AppMode)[keyof typeof AppMode];

/*
 * Running-mode resolution (pure function, Pi's `resolveAppMode` counterpart).
 * TTY detection is passed in by the host (`!Console.IsInputRedirected` etc.) so
 * the resolver itself never touches I/O and any language CLI rewrite can reuse
 * the exact same rules. Precedence (short paths first, then explicit --mode,
 * then prompt / --resume / --print / TTY):
 * version/info/help/list-models/stats/skill-eval → that mode;
 * --mode json|print|interactive|rpc → that mode;
 * positionals > 0 → print (`di "prompt"` single shot);
 * --resume present → interactive (continue only after user input);
 * --print or stdin/stdout not a TTY → print (`echo x | di`);
 * otherwise → interactive.
 */
export const CliMode = {
  resolve(args: CliArgs, stdinIsTty: boolean, stdoutIsTty: boolean): AppMode {
    // Short paths win: version / info / help / list-models / stats / skill-eval
    // exit without entering the loop.
    if (args.version) return AppMode.Version;
    if (args.info) return AppMode.Info;
    if (args.help) return AppMode.Help;
    if (args.listModels !== null) return AppMode.ListModels;
    if (args.stats !== undefined) return AppMode.Stats;
    if (args.skillEval !== undefined) return AppMode.SkillEval;

    // Explicit --mode wins; otherwise derive from prompt / --resume / TTY.
    switch (args.mode) {
      case "json":
        return AppMode.Json;
      case "print":
        return AppMode.Print;
      case "interactive":
        return AppMode.Interactive;
      case "rpc":
        return AppMode.Rpc;
      default:
        if (args.positionals.length > 0) return AppMode.Print; // di "prompt" → single shot
        if (args.resume !== undefined) return AppMode.Interactive; // continue only after user input
        return args.print || !stdinIsTty || !stdoutIsTty ? AppMode.Print : AppMode.Interactive;
    }
  },
};
