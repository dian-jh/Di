import test from "node:test";
import assert from "node:assert/strict";
import { AppMode, CliArgsParser, CliMode } from "@di/coding-agent";

/**
 *
 * pessimistic rules — unknown flags, missing values, invalid --mode, `--`
 * terminator and the optional --list-models pattern.
 */

function parse(...args: string[]) {
  return CliArgsParser.parse(args);
}

test("Parse_NoArgs_EmptyArgsNoDiagnostics", () => {
  const { args, diagnostics } = parse();

  assert.deepEqual(args.positionals, []);
  assert.deepEqual(diagnostics, []);
  assert.equal(args.print, false);
  assert.equal(args.version, false);
  assert.equal(args.help, false);
  assert.equal(args.model, undefined);
});

test("Parse_ResumePath_EntersInteractiveMode", () => {
  const { args, diagnostics } = parse("--resume", "session.jsonl");

  assert.deepEqual(diagnostics, []);
  assert.equal(args.resume, "session.jsonl");
  assert.equal(CliMode.resolve(args, false, false), AppMode.Interactive);
});

test("Parse_Positionals_CapturedInOrder", () => {
  const { args, diagnostics } = parse("hello", "world");

  assert.deepEqual(args.positionals, ["hello", "world"]);
  assert.deepEqual(diagnostics, []);
});

test("Parse_ShortModelFlag_TakesValue", () => {
  const { args, diagnostics } = parse("-m", "deepseek-v4-pro");

  assert.equal(args.model, "deepseek-v4-pro");
  assert.deepEqual(diagnostics, []);
});

test("Parse_LongModelFlag_TakesValue", () => {
  const { args, diagnostics } = parse("--model", "deepseek-flash");

  assert.equal(args.model, "deepseek-flash");
  assert.deepEqual(diagnostics, []);
});

test("Parse_ProviderFlag_TakesValue", () => {
  const { args, diagnostics } = parse("--provider", "deepseek");

  assert.equal(args.provider, "deepseek");
  assert.deepEqual(diagnostics, []);
});

test("Parse_PrintFlag_True", () => {
  const { args, diagnostics } = parse("--print");

  assert.equal(args.print, true);
  assert.deepEqual(diagnostics, []);
});

test("Parse_ModeJson_Value", () => {
  const { args, diagnostics } = parse("--mode", "json");

  assert.equal(args.mode, "json");
  assert.deepEqual(diagnostics, []);
});

test("Parse_VersionFlag_True", () => {
  const { args, diagnostics } = parse("--version");

  assert.equal(args.version, true);
  assert.deepEqual(diagnostics, []);
});

test("Parse_InfoFlag_True", () => {
  const { args, diagnostics } = parse("--info");

  assert.equal(args.info, true);
  assert.deepEqual(diagnostics, []);
});

test("Parse_ShortHelpFlag_True", () => {
  const { args, diagnostics } = parse("-h");

  assert.equal(args.help, true);
  assert.deepEqual(diagnostics, []);
});

test("Parse_LongHelpFlag_True", () => {
  const { args, diagnostics } = parse("--help");

  assert.equal(args.help, true);
  assert.deepEqual(diagnostics, []);
});

test("Parse_NoSession_True", () => {
  const { args, diagnostics } = parse("--no-session");

  assert.equal(args.noSession, true);
  assert.deepEqual(diagnostics, []);
});

test("Parse_NoAnsi_True", () => {
  const { args, diagnostics } = parse("--no-ansi");

  assert.equal(args.noAnsi, true);
  assert.deepEqual(diagnostics, []);
});

test("Parse_Thinking_TakesValue", () => {
  const { args, diagnostics } = parse("--thinking", "high");

  assert.equal(args.thinking, "high");
  assert.deepEqual(diagnostics, []);
});

test("Parse_ListModels_WithoutPattern_EmptyString", () => {
  const { args, diagnostics } = parse("--list-models");

  assert.equal(args.listModels, "");
  assert.deepEqual(diagnostics, []);
});

test("Parse_ListModels_WithPattern_TakesValue", () => {
  const { args, diagnostics } = parse("--list-models", "deepseek");

  assert.equal(args.listModels, "deepseek");
  assert.deepEqual(diagnostics, []);
});

test("Parse_ListModels_StopsAtFlag_DoesNotConsumeFlag", () => {
  const { args, diagnostics } = parse("--list-models", "--version");

  assert.equal(args.listModels, "");
  assert.equal(args.version, true); // --version is still a flag, not swallowed as a pattern
  assert.deepEqual(diagnostics, []);
});

test("Parse_Stats_TakesRequiredValue", () => {
  const { args, diagnostics } = parse("--stats", "session.jsonl");

  assert.equal(args.stats, "session.jsonl");
  assert.deepEqual(diagnostics, []);
});

test("Parse_StatsMissingValue_AddsDiagnosticError", () => {
  const { args, diagnostics } = parse("--stats");

  assert.equal(args.stats, undefined);
  assert.ok(diagnostics.some((d) => d.isError));
});

test("Parse_SkillEval_TakesRequiredValue", () => {
  const { args, diagnostics } = parse("--skill-eval", "cases.json");

  assert.equal(args.skillEval, "cases.json");
  assert.deepEqual(diagnostics, []);
});

test("Parse_SkillEvalMissingValue_AddsDiagnosticError", () => {
  const { args, diagnostics } = parse("--skill-eval");

  assert.equal(args.skillEval, undefined);
  assert.ok(diagnostics.some((d) => d.isError));
});

test("Parse_UnknownFlag_AddsDiagnosticError", () => {
  const { args, diagnostics } = parse("--bogus", "hi");

  assert.deepEqual(args.positionals, ["hi"]);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.isError, true);
  assert.ok(diagnostics[0]!.message.includes("--bogus"));
  assert.ok(args.unknownFlags.includes("--bogus"));
});

test("Parse_UnknownShortFlag_AddsDiagnosticError", () => {
  const { args, diagnostics } = parse("-x");

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.isError, true);
  assert.ok(args.unknownFlags.includes("-x"));
});

test("Parse_ModelMissingValue_AddsDiagnosticError", () => {
  const { diagnostics } = parse("--model");

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.isError, true);
  assert.ok(diagnostics[0]!.message.includes("--model"));
});

test("Parse_ModelFlagFollowedByFlag_ReportsMissingValue", () => {
  // -m followed by another flag: do not swallow the flag as a value, report "缺值" instead.
  const { args, diagnostics } = parse("-m", "--version");

  assert.equal(args.model, undefined);
  assert.equal(args.version, true);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.isError, true);
});

test("Parse_InvalidModeValue_AddsDiagnosticError", () => {
  const { args, diagnostics } = parse("--mode", "bogus");

  assert.equal(args.mode, "bogus");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.isError, true);
  assert.ok(diagnostics[0]!.message.includes("bogus"));
});

test("Parse_DoubleDash_RestArePositionalsEvenIfDashed", () => {
  const { args, diagnostics } = parse("--", "--version", "-m");

  assert.deepEqual(args.positionals, ["--version", "-m"]);
  assert.equal(args.version, false); // "--" stops flag parsing
  assert.deepEqual(diagnostics, []);
});

test("Parse_FlagsBeforePositional_Combine", () => {
  const { args, diagnostics } = parse("--print", "-m", "deepseek-flash", "跑测试");

  assert.equal(args.print, true);
  assert.equal(args.model, "deepseek-flash");
  assert.deepEqual(args.positionals, ["跑测试"]);
  assert.deepEqual(diagnostics, []);
});
