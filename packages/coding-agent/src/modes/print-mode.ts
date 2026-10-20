import type { AgentResult } from "@di/agent";
import type { CliArgs } from "../cli/args.ts";
import type { CliHost } from "../cli/cli-host.ts";
import type { TextReader, TextWriter } from "../cli/io.ts";
import { appendTurn, applySkills, errorMessage, resolvePrompt, startSession } from "./common.ts";
import { drainEvents, EventRenderer, renderAll } from "./event-renderer.ts";

/**
 * Headless text single-shot mode (C# `Di.Cli/modes/PrintMode.cs` at baseline
 * 09f4e08; Pi's print mode): runs one turn then exits. Events stream to stdout in
 * real time (ANSI disabled; under a real terminal the "正在请求模型…" status line
 * is shown until the first event arrives — omitted on pipe/redirect so captured
 * output stays clean). Prompt = joined positionals, or stdin to EOF. Failure
 * paths (empty prompt / runner throw / StopReason.Error) exit 1; the session log
 * is best-effort (`--no-session` disables). Internal camelCase never leaks — only
 * the EventRenderer's human-readable text is written.
 */
export async function runPrintMode(
  host: CliHost,
  args: CliArgs,
  stdin: TextReader,
  stdout: TextWriter,
  stderr: TextWriter,
  stdoutTty = false,
  signal?: AbortSignal,
): Promise<number> {
  if (host == null) throw new TypeError("runPrintMode: host is required");
  const prompt = await resolvePrompt(args, stdin, signal);
  if (prompt.trim().length === 0) {
    stderr.writeLine("缺少提示词：给一个位置参数（di \"提示词\"）或从 stdin 传入（echo ... | di）");
    return 1;
  }

  // --model 覆盖当前模型（headless 单发没有 /model 切换，必须在启动时定好）。
  if (args.model !== undefined) host.runner.setCurrentModel(args.model);

  const consumer = host.bus.subscribe();
  // 思考增量只在真实终端渲染（消除思考期死屏）；管道/重定向不渲染，保持捕获输出干净。
  const renderer = new EventRenderer(stdout, false, stdoutTty);
  const renderTask = renderAll(consumer, renderer);

  const startedAt = Date.now();
  startSession(host, args, stderr);
  applySkills(host, prompt);

  // 真实终端等待模型首 token 期间显示"正在请求模型…"；管道/重定向省略，避免污染捕获输出。
  if (stdoutTty) renderer.showStatus("⟳ 正在请求模型…");

  let result: AgentResult;
  try {
    result = await host.runner.runTurn(prompt, signal);
  } catch (error) {
    host.bus.release(consumer);
    await renderTask;
    stderr.writeLine(`✗ 运行失败: ${errorMessage(error)}`);
    return 1;
  }

  host.bus.release(consumer);
  await renderTask;
  // 兜底：取消瞬间渲染任务未消费的残余事件（发布同步入队，不会丢失）。
  drainEvents(consumer, renderer);

  if (result.stopReason === "error") {
    const failure = result.failure;
    stderr.writeLine(`✗ 失败: [${failure?.code}] ${failure?.message ?? result.answer}`);
    return 1;
  }

  appendTurn(host, args, result, startedAt, stderr);
  renderer.renderResult(result);
  return 0;
}
