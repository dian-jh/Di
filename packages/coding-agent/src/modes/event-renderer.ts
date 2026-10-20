import type { AgentEvent, AgentResult } from "@di/agent";
import type { UsageCost } from "@di/ai";
import type { TextWriter } from "../cli/io.ts";
import { EventConsumer } from "../core/events/event-bus.ts";

/**
 * Renders AgentLoopEvents and AgentResult into terminal text (the C#
 * `Di.Cli/EventRenderer.cs` counterpart at baseline 09f4e08): TextDelta appends
 * in real time (streaming), other events each become a line; RenderResult prints
 * the meta footnote and, for non-streamed answers (final_output_tool /
 * max_iterations), the final text so a capped run is never silent. ReasoningDelta
 * renders only when `renderReasoning` is enabled (a real terminal — never pipe /
 * redirect, keeping captured output clean).
 */

/** One turn's accumulated cost in USD (C# `UsageCost.Total`). */
export function usageCostTotal(cost: UsageCost): number {
  return cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
}

/** Write a readable usage summary for the meta footnote. */
export function formatUsage(usage: { inputTokens: number; outputTokens: number }): string {
  return `in:${usage.inputTokens} out:${usage.outputTokens}`;
}

/** Live consumption: forward every event to the renderer; a render failure never interrupts the turn. */
export async function renderAll(consumer: EventConsumer, renderer: EventRenderer): Promise<void> {
  for await (const event of consumer) {
    try {
      renderer.render(event);
    } catch {
      // 渲染失败不打断回合。
    }
  }
}

/** Drain whatever the render task did not consume (C# `Drain`). */
export function drainEvents(consumer: EventConsumer, renderer: EventRenderer): void {
  let event = consumer.tryRead();
  while (event !== null) {
    renderer.render(event);
    event = consumer.tryRead();
  }
}

/** Renderer over an injected writer (the `TextWriter` seam; no console dependency). */
export class EventRenderer {
  private lineOpen_ = false; // current line has un-newlined streamed text
  private statusShown_ = false; // a "working…" status line is being shown
  private reasoningOpen_ = false; // currently streaming the reasoning block

  private readonly output: TextWriter;
  private readonly useAnsi: boolean;
  private readonly renderReasoning: boolean;

  constructor(output: TextWriter, useAnsi = true, renderReasoning = false) {
    if (output == null) throw new TypeError("EventRenderer: output is required");
    this.output = output;
    this.useAnsi = useAnsi;
    this.renderReasoning = renderReasoning;
  }

  /** Show a "working…" status line; erased by the first event/result render. */
  showStatus(text: string): void {
    this.output.writeLine(text);
    this.statusShown_ = true;
  }

  /** Clear the status line (ANSI clear when enabled; otherwise it already has its own newline). */
  clearStatus(): void {
    if (!this.statusShown_) return;
    this.statusShown_ = false;
    if (this.useAnsi) this.output.write("\r\x1b[2K");
  }

  render(event: AgentEvent): void {
    this.clearStatus();
    switch (event.type) {
      case "reasoningDelta":
        // 思考内容（先于回答流式到达）——仅在显式开启时渲染；默认关闭（管道/重定向捕获保持干净）。
        if (!this.renderReasoning) break;
        if (!this.reasoningOpen_) {
          this.output.writeLine("  ── 思考中 ──");
          this.reasoningOpen_ = true;
        }
        this.output.write(event.delta);
        break;
      case "textDelta":
        this.closeReasoning_();
        this.output.write(event.delta);
        this.lineOpen_ = true;
        break;
      case "turnCompleted": {
        this.closeReasoning_();
        this.closeLine_();
        let line = `  ── 第 ${event.iteration} 轮思考完成  in:${event.usage.inputTokens} out:${event.usage.outputTokens}`;
        if (event.cost !== undefined) line += `  cost:$${usageCostTotal(event.cost).toFixed(6)}`;
        this.output.writeLine(line);
        break;
      }
      case "toolStarted":
        this.closeReasoning_();
        this.closeLine_();
        this.output.writeLine(`  → 调用工具 ${event.call.name}(${event.call.arguments})`);
        break;
      case "toolCompleted":
        this.closeReasoning_();
        this.output.writeLine(`  ← ${event.isError ? "ERROR" : "ok"}  ${event.observation}`);
        break;
      case "runFailed":
        this.closeReasoning_();
        this.closeLine_();
        this.output.writeLine(`  ✗ 失败: [${event.failure.code}] ${event.failure.message}`);
        break;
      case "interrupted":
        // 软停止请求已在某个相位边界生效：未开始的工作不再执行，回合即将正常收敛。
        this.clearStatus();
        this.closeReasoning_();
        this.closeLine_();
        this.output.writeLine("  ⏹ 已收到中断，正在安全停下…");
        break;
    }
  }

  renderResult(result: AgentResult): void {
    this.clearStatus();
    this.closeReasoning_();
    this.closeLine_();
    this.output.writeLine();

    if (result.stopReason === "final_output_tool") {
      // 最终输出工具的答案（参数）未经流式渲染，这里打印。
      this.output.writeLine("════ 回答 ════");
      this.output.writeLine(result.answer);
    } else if (result.stopReason === "max_iterations") {
      // 预算耗尽兜底：打印模型最后一段文本，让调用方至少有可见的收尾。
      this.output.writeLine("⚠ 已达迭代上限，任务可能未完成。模型最后输出：");
      if (result.answer.trim().length > 0) this.output.writeLine(result.answer);
    } else if (result.stopReason === "interrupted") {
      // 软停止：模型已产出的文本在流式下已实时显示，这里只补一行状态说明。
      this.output.writeLine("⏹ 已中断：未开始的工作不再执行。");
    }

    if (result.stopReason === "context_limit") {
      this.output.writeLine("上下文预算已用尽，当前轨迹已保留。请先提炼状态，再以新任务继续。");
    }
    let footnote = `（${result.stopReason} · ${result.iterations} 轮 · tokens: ${formatUsage(result.usage)}`;
    if (result.cost !== undefined) footnote += ` · cost:$${usageCostTotal(result.cost).toFixed(6)}`;
    this.output.writeLine(footnote + "）");
  }

  /** If the reasoning block is open, close it with a newline so the next content does not stick. */
  private closeReasoning_(): void {
    if (!this.reasoningOpen_) return;
    this.output.writeLine();
    this.reasoningOpen_ = false;
  }

  /** If a streamed text line is open, close it so the next line does not stick. */
  private closeLine_(): void {
    if (!this.lineOpen_) return;
    this.output.writeLine();
    this.lineOpen_ = false;
  }
}
