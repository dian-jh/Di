import type { AgentResult } from "@di/agent";
import { LexicalSkillMatcher } from "../core/skills/skill-matcher.ts";
import { computeSkillActivation } from "../core/skills/skill-activation.ts";
import type { CliArgs } from "../cli/args.ts";
import type { CliHost } from "../cli/cli-host.ts";
import type { TextReader, TextWriter } from "../cli/io.ts";

/*
 * Shared headless-mode helpers: prompt resolution (positionals, else stdin to EOF), the
 * best-effort session log (start / append / failure — a disk error only warns,
 * never changes the exit code; `--no-session` skips the whole path), and the
 * headless skill auto-activation (same shared computation as the REPL).
 */

/** Error-to-message coercion (`ex.Message`). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Prompt: join positionals with a space, else read stdin to EOF and trim (`ReadToEndAsync.Trim`). */
export async function resolvePrompt(
  args: CliArgs,
  stdin: TextReader,
  _signal?: AbortSignal,
): Promise<string> {
  if (args.positionals.length > 0) return args.positionals.join(" ");
  const parts: string[] = [];
  while (true) {
    const line = await stdin.readLine();
    if (line === null) break;
    parts.push(line);
  }
  return parts.join("\n").trim();
}

/** Start the session log best-effort; a failure only warns on stderr (never changes the exit code). */
export function startSession(host: CliHost, args: CliArgs, stderr: TextWriter): void {
  if (args.noSession) return;
  try {
    host.sessionStore?.startSession();
  } catch (error) {
    stderr.writeLine(`⚠ 会话日志初始化失败: ${errorMessage(error)}`);
  }
}

/** Persist a completed turn best-effort. `--no-session` skips the whole path. */
export function appendTurn(host: CliHost, args: CliArgs, result: AgentResult, startedAt: number, stderr: TextWriter): void {
  if (args.noSession) return;
  try {
    host.sessionStore?.appendTurn(result, startedAt);
  } catch (error) {
    stderr.writeLine(`⚠ 会话日志写入失败: ${errorMessage(error)}`);
  }
}

/** Persist a failed turn best-effort (a failure must leave a trace). `--no-session` skips. */
export function appendFailure(
  host: CliHost,
  args: CliArgs,
  userMessage: string,
  message: string,
  startedAt: number,
  stderr: TextWriter,
): void {
  if (args.noSession) return;
  try {
    host.sessionStore?.appendFailure(userMessage, message, startedAt);
  } catch (error) {
    stderr.writeLine(`⚠ 会话日志写入失败: ${errorMessage(error)}`);
  }
}

/**
 * Headless skill auto-activation (same shared computation as the REPL): the same
 * prompt activates the same skills in every mode. Pinned set is empty here (a
 * single-shot has no session to pin into); the activation result is written to
 * the runner, which injects the active skills' full instructions.
 */
export function applySkills(host: CliHost, prompt: string): void {
  const activation = computeSkillActivation(prompt, host.skills, [], new LexicalSkillMatcher());
  host.runner.setActiveSkills(activation.active);
}
