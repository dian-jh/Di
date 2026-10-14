/**
 * 聊天消息组件：
 * - UserMessage：用户消息（`❯` 前缀）。
 * - AssistantMessage：推理区（有内容才渲染）+ 工具调用行 + 流式答案。
 *
 * 流式答案 M1 用纯 Text（自动换行、无格式），避免半成品 Markdown 渲染抖动；
 * Markdown 主题化属于 M2/M3。
 */

import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { ToolCallView } from "./tool-call.ts";
import { Rule } from "./rule.ts";
import type { ToolCallEntry } from "./state.ts";

/** 用户消息：浅灰条形框（上/下边）+ `❯ 内容`，与非用户输入区分。 */
export class UserMessage extends Container {
  constructor(content: string) {
    super();
    this.addChild(new Rule());
    this.addChild(new Text(`❯ ${content}`, 1, 0));
    this.addChild(new Rule());
  }
}

/** 斜杠命令应答：以 `‖ ` 前缀的多行系统消息。 */
export class SystemMessage extends Container {
  constructor(content: string) {
    super();
    this.addChild(new Text(content.split("\n").map((line) => `‖ ${line}`).join("\n"), 1, 0));
  }
}

/** 助手消息：推理区 + 工具调用行 + 流式答案（推理/工具为空时零行渲染）。 */
export class AssistantMessage extends Container {
  private readonly reasoning: Text;
  private readonly answer: Text;
  private readonly toolCalls = new Map<string, ToolCallView>();
  private reasoningMounted = false;

  constructor() {
    super();
    this.reasoning = new Text("", 1, 0);
    this.answer = new Text("", 1, 0);
    this.addChild(this.answer); // 答案始终是最后一个 child
  }

  /** 更新推理缓冲；非空时首次挂载推理组件（置于最前）。 */
  setReasoning(text: string): void {
    const has = text.trim().length > 0;
    if (has && !this.reasoningMounted) {
      this.children.splice(0, 0, this.reasoning);
      this.reasoningMounted = true;
    }
    this.reasoning.setText(has ? `〔思考〕\n${text}` : "");
  }

  /** 流式追加：直接用最新完整文本刷新（Text 按 text+width 缓存，重复 setText 廉价）。 */
  setAnswer(text: string): void {
    this.answer.setText(text);
  }

  /** 与状态机的工具条目同步：新增/更新工具行，移除已消失的。 */
  syncToolCalls(entries: Iterable<ToolCallEntry>): void {
    const seen = new Set<string>();
    for (const entry of entries) {
      seen.add(entry.id);
      let view = this.toolCalls.get(entry.id);
      if (!view) {
        view = new ToolCallView();
        this.toolCalls.set(entry.id, view);
        this.insertBefore(view.component, this.answer);
      }
      view.update(entry);
    }
    for (const [id, view] of this.toolCalls) {
      if (!seen.has(id)) {
        this.removeChild(view.component);
        this.toolCalls.delete(id);
      }
    }
  }

  /** 把 component 插到 ref 之前（保持答案在末尾）。 */
  private insertBefore(component: Component, ref: Component): void {
    const index = this.children.indexOf(ref);
    if (index === -1) {
      this.addChild(component);
      return;
    }
    this.children.splice(index, 0, component);
  }
}
