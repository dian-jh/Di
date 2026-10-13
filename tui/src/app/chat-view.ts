/**
 * 聊天视口（M1 常规主屏模式）：transcript(Container) + 错误横幅 + 状态行 + 提示输入。
 * 常规模式下终端随内容自然滚动，不依赖 alt-screen 布局引擎（那是 M2）。
 */

import { Container, Input, Text, type TuiMainScreen } from "@earendil-works/pi-tui";
import { AssistantMessage, SystemMessage, UserMessage } from "./message.ts";
import type { TurnStateMachine } from "./state.ts";

export class ChatView {
  private readonly tui: TuiMainScreen;
  private readonly transcript: Container;
  private readonly banner: Text;
  private readonly status: Text;
  private readonly input: Input;
  private readonly onSubmit: (text: string) => void;

  private assistant: AssistantMessage | null = null;
  private renderedTurnId = 0;
  private renderedCommandSeq = 0;

  constructor(tui: TuiMainScreen, onSubmit: (text: string) => void) {
    this.tui = tui;
    this.onSubmit = onSubmit;

    this.transcript = new Container();
    this.banner = new Text("", 1, 0);
    this.status = new Text("", 1, 0);
    this.input = new Input({ prompt: "❯ " });
    this.input.onSubmit = (value) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue("");
      this.onSubmit(text);
    };

    const root = new Container();
    root.addChild(this.transcript);
    root.addChild(this.banner);
    root.addChild(this.status);
    root.addChild(this.input);
    this.tui.addChild(root);
  }

  /** 聚焦输入框。 */
  focusInput(): void {
    this.tui.setFocus(this.input);
  }

  /** 把状态机的视图模型同步到组件树，并请求重绘。 */
  sync(state: TurnStateMachine): void {
    const turn = state.current;
    if (turn && turn.id !== this.renderedTurnId) {
      // 新回合：追加用户消息 + 新建助手消息。
      this.transcript.addChild(new UserMessage(turn.userMessage));
      this.assistant = new AssistantMessage();
      this.transcript.addChild(this.assistant);
      this.renderedTurnId = turn.id;
    }
    if (turn && this.assistant) {
      this.assistant.setReasoning(turn.reasoning);
      this.assistant.setAnswer(turn.answer);
      this.assistant.syncToolCalls(turn.toolCalls.values());
    }
    // 斜杠命令：输出序号变化 → 追加「用户输入 + 系统应答」两条消息（命令不建回合）。
    if (state.commandSeq !== this.renderedCommandSeq) {
      this.renderedCommandSeq = state.commandSeq;
      if (state.commandInput) {
        this.transcript.addChild(new UserMessage(state.commandInput));
      }
      if (state.commandOutput) {
        this.transcript.addChild(new SystemMessage(state.commandOutput));
      }
    }
    this.banner.setText(state.errorBanner ?? "");
    this.status.setText(state.statusText);
    this.tui.requestRender();
  }
}
