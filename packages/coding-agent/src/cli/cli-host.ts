import type { ModelSelection } from "../core/model-selection.ts";
import type { Skill } from "../core/skills/skill.ts";
import type { CliArgs } from "./args.ts";
import type { TextWriter } from "./io.ts";

/**
 * CLI host seam (the composition root; C# `Di.Cli/CliHost.cs` at baseline
 * 09f4e08). The shell's host-requiring paths consume only what this card needs —
 * the model selection (list-models / later /model) and the discovered skills
 * (skill-eval) — and the factory is injected so the dispatch shell never builds
 * DI itself. Interactive / print / json / rpc bodies (P6.3c) extend this
 * interface with the command registry / agent session / session store seams.
 */
export interface CliHost {
  /** Model selection: advisory catalog + provider/model resolution (--list-models, /model). */
  readonly models: ModelSelection;
  /** Skills discovered by the host (skill-eval uses the production-identical set). */
  readonly skills: readonly Skill[];
}

/**
 * Host factory (C# `Func<CliArgs, string, TextWriter, bool, CliHost>`): called
 * with the parsed args, the current workspace, a stderr writer for construction
 * warnings and the ANSI decision (`stdoutTty && !noAnsi`). A throwing factory is
 * turned into the documented host-failure output (json → stdout error envelope,
 * text modes → stderr) by the dispatch shell.
 */
export type CliHostFactory = (
  args: CliArgs,
  workspace: string,
  stderr: TextWriter,
  useAnsi: boolean,
) => CliHost;

/**
 * Default host factory: the real composition root is a later phase (P7), so this
 * fails closed with an honest message instead of pretending to build a working
 * host. Injected factories replace it in tests / embedded hosts.
 */
export const defaultCliHostFactory: CliHostFactory = () => {
  throw new Error("CLI 宿主组合尚未在 TypeScript 后端实现（P7 接线）。");
};
