import test from "node:test";
import assert from "node:assert/strict";
import { AppMode, type CliArgs, CliMode } from "@di/coding-agent";

/**
 * P6.3b card — CLI mode resolution (port of C# `Di.Cli.Tests/cli/CliModeTests.cs`
 * at baseline 09f4e08): the pure precedence `CliMode.Resolve(args, stdinTty,
 * stdoutTty)` — short paths first (version/info/help/list-models/stats/skill-eval),
 * then explicit --mode, then prompt / --resume / --print / TTY derivation. The
 * `--resume` × explicit-mode × positional combinations are added beyond the C#
 * suite to lock the contract the validation doc demands (resume never defaults
 * into a mode that swallows an explicit choice).
 */

function args(init: Partial<CliArgs> = {}): CliArgs {
  return {
    positionals: [],
    model: undefined,
    provider: undefined,
    print: false,
    mode: undefined,
    version: false,
    info: false,
    help: false,
    listModels: null,
    stats: undefined,
    skillEval: undefined,
    thinking: undefined,
    noSession: false,
    resume: undefined,
    noAnsi: false,
    unknownFlags: [],
    ...init,
  };
}

const TTY = true;
const NOT_TTY = false;

test("Resolve_TtyTtyNoPrompt_Interactive", () => {
  assert.equal(CliMode.resolve(args({}), TTY, TTY), AppMode.Interactive);
});

test("Resolve_PositionalPrompt_Print", () => {
  assert.equal(CliMode.resolve(args({ positionals: ["读一下 README"] }), TTY, TTY), AppMode.Print);
});

test("Resolve_PrintFlag_Print", () => {
  assert.equal(CliMode.resolve(args({ print: true }), TTY, TTY), AppMode.Print);
});

test("Resolve_StdinNotTty_Print", () => {
  assert.equal(CliMode.resolve(args({}), NOT_TTY, TTY), AppMode.Print);
});

test("Resolve_StdoutNotTty_Print", () => {
  assert.equal(CliMode.resolve(args({}), TTY, NOT_TTY), AppMode.Print);
});

test("Resolve_ExplicitModeJson_JsonEvenOnTty", () => {
  assert.equal(CliMode.resolve(args({ mode: "json" }), TTY, TTY), AppMode.Json);
});

test("Resolve_ExplicitModeJson_OverridesPositional", () => {
  assert.equal(CliMode.resolve(args({ mode: "json", positionals: ["prompt"] }), TTY, TTY), AppMode.Json);
});

test("Resolve_ExplicitModePrint_PrintEvenOnTty", () => {
  assert.equal(CliMode.resolve(args({ mode: "print" }), TTY, TTY), AppMode.Print);
});

test("Resolve_ExplicitModeInteractive_OverridesPositionalAndNonTty", () => {
  assert.equal(CliMode.resolve(args({ mode: "interactive", positionals: ["prompt"] }), NOT_TTY, NOT_TTY), AppMode.Interactive);
});

test("Resolve_ExplicitModeRpc_Rpc", () => {
  assert.equal(CliMode.resolve(args({ mode: "rpc" }), TTY, TTY), AppMode.Rpc);
});

test("Resolve_Version_PriorityOverModeAndPrompt", () => {
  assert.equal(CliMode.resolve(args({ version: true, mode: "json", positionals: ["prompt"] }), TTY, TTY), AppMode.Version);
});

test("Resolve_Info_PriorityOverPromptAndMode", () => {
  assert.equal(CliMode.resolve(args({ info: true, mode: "json", positionals: ["prompt"] }), TTY, TTY), AppMode.Info);
});

test("Resolve_Help_PriorityOverEverything", () => {
  assert.equal(CliMode.resolve(args({ help: true, mode: "json" }), TTY, TTY), AppMode.Help);
});

test("Resolve_ListModels_PriorityOverPrompt", () => {
  assert.equal(CliMode.resolve(args({ listModels: "", positionals: ["prompt"] }), TTY, TTY), AppMode.ListModels);
});

test("Resolve_Stats_PriorityOverPrompt", () => {
  assert.equal(CliMode.resolve(args({ stats: "session.jsonl", positionals: ["prompt"] }), TTY, TTY), AppMode.Stats);
});

test("Resolve_SkillEval_PriorityOverPrompt", () => {
  assert.equal(CliMode.resolve(args({ skillEval: "cases.json", positionals: ["prompt"] }), TTY, TTY), AppMode.SkillEval);
});

// ---- --resume precedence (validation-and-release.md §分层测试计划) ----

test("Resolve_ResumeNoModeNoPositionals_Interactive", () => {
  // `--resume` with no explicit --mode and no positional prompt enters a simple
  // interactive session (the body itself is P6.3c; the resolution rule belongs here).
  assert.equal(CliMode.resolve(args({ resume: "checkpoint.jsonl" }), TTY, TTY), AppMode.Interactive);
  assert.equal(CliMode.resolve(args({ resume: "checkpoint.jsonl" }), NOT_TTY, NOT_TTY), AppMode.Interactive);
});

test("Resolve_ResumeWithPositionals_Print", () => {
  // Positionals still win over --resume: `di --resume file "继续"` is a single shot.
  assert.equal(CliMode.resolve(args({ resume: "checkpoint.jsonl", positionals: ["继续"] }), TTY, TTY), AppMode.Print);
});

test("Resolve_ResumeWithExplicitMode_ExplicitModeWins", () => {
  assert.equal(CliMode.resolve(args({ resume: "checkpoint.jsonl", mode: "json" }), TTY, TTY), AppMode.Json);
  assert.equal(CliMode.resolve(args({ resume: "checkpoint.jsonl", mode: "print" }), NOT_TTY, NOT_TTY), AppMode.Print);
});

test("Resolve_ResumeWithPrintFlag_ResumeWinsOverPrint", () => {
  // C# checks --resume before --print: `--resume file --print` (no mode/positionals)
  // still enters interactive; --print only matters when --resume is absent.
  assert.equal(CliMode.resolve(args({ resume: "checkpoint.jsonl", print: true }), TTY, TTY), AppMode.Interactive);
  assert.equal(CliMode.resolve(args({ print: true }), TTY, TTY), AppMode.Print);
});
