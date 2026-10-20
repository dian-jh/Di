import type { AgentResult } from "@di/agent";
import type { CliArgs } from "../cli/args.ts";
import type { CliHost } from "../cli/cli-host.ts";
import type { TextReader, TextWriter } from "../cli/io.ts";
import { appendTurn, applySkills, errorMessage, resolvePrompt, startSession } from "./common.ts";
import { usageCostTotal } from "./event-renderer.ts";

/**
 * Headless JSON single-shot mode (the JSON half of C# `Di.Cli/modes/PrintMode.cs`
 * at baseline 09f4e08; --mode json): runs one turn then emits EXACTLY ONE JSON
 * document on stdout (script friendly) — no human-readable events, no stray
 * lines. Wire shape is snake_case; nullable keys (cost) are omitted, never null;
 * failures exit 1 with `{"error":{"code":...,"message":...}}` (usage / model_error
 * / the StopReason.Error code). Session log best-effort (`--no-session` disables).
 */
export async function runJsonMode(
  host: CliHost,
  args: CliArgs,
  stdin: TextReader,
  stdout: TextWriter,
  stderr: TextWriter,
  signal?: AbortSignal,
): Promise<number> {
  if (host == null) throw new TypeError("runJsonMode: host is required");
  const prompt = await resolvePrompt(args, stdin, signal);
  if (prompt.trim().length === 0) {
    writeErrorJson(stdout, "usage", "缺少提示词：给一个位置参数（di \"提示词\"）或从 stdin 传入（echo ... | di）");
    return 1;
  }

  // --model 覆盖当前模型（headless 单发没有 /model 切换，必须在启动时定好）。
  if (args.model !== undefined) host.runner.setCurrentModel(args.model);

  const startedAt = Date.now();
  startSession(host, args, stderr);
  applySkills(host, prompt);

  let result: AgentResult;
  try {
    result = await host.runner.runTurn(prompt, signal);
  } catch (error) {
    writeErrorJson(stdout, "model_error", errorMessage(error));
    return 1;
  }

  if (result.stopReason === "error") {
    const failure = result.failure;
    writeErrorJson(stdout, failure?.code ?? "model_error", failure?.message ?? "模型调用失败");
    return 1;
  }

  appendTurn(host, args, result, startedAt, stderr);

  const doc: Record<string, unknown> = {
    answer: result.answer,
    stop_reason: result.stopReason === "context_limit" ? "context_limit" : result.stopReason,
    iterations: result.iterations,
    usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens },
  };
  if (result.cost !== undefined) doc["cost"] = usageCostTotal(result.cost);
  stdout.writeLine(JSON.stringify(doc));
  return 0;
}

/** JSON error document: `{"error": {"code": ..., "message": ...}}` (script parseable). */
function writeErrorJson(stdout: TextWriter, code: string, message: string): void {
  stdout.writeLine(JSON.stringify({ error: { code, message } }));
}
