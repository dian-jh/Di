/**
 * 聊天视口：支持两种终端渲染模式。
 *
 * 1. 现代终端（Windows Terminal / mintty / VS Code 等，SGR 滚轮可用）：
 *    TuiAltScreen 全屏视口 —— transcript ScrollView + 底部固定 dock（createChatLayout），
 *    输入框永远贴着终端底部；滚轮 / PgUp / PgDn 由 TuiAltScreen 内置处理。
 *
 * 2. 经典 conhost（cmd 窗口）：SGR 鼠标事件到不了 Node 进程（pi 同方案的铁证），
 *    应用内捕获滚轮在 cmd 里是死路 —— 改用 TuiMainScreen 渲染进主缓冲
 *    （createMainScreenLayout）：conhost 自己的 scrollback 累积整份文档，
 *    滚轮由控制台原生滚动历史；输入框位于文档末尾，跟随光标停在视口底部。
 *    由 main.ts 按 isClassicConhost() 选择模式。
 *
 * M3 增量：消息与输入框统一浅灰框线；用户输入自带浅灰条形框（区分非用户输入）；
 * 模型徽标（模型 · 强度）固定在输入框下方独立一行、右对齐，终端一开即显示；状态行
 * 记录最近一回合的 token/成本统计；命令模式（Editor 内置斜杠菜单 + 模糊补全）。
 */

import {
  type AutocompleteItem,
  CombinedAutocompleteProvider,
  type Component,
  Container,
  Editor,
  type EditorTheme,
  getTerminalColorMode,
  parseColor,
  type SlashCommand,
  styleText,
  Text,
  TuiAltScreen,
  type TuiMainScreen,
} from "@earendil-works/pi-tui";
import { AssistantMessage, SystemMessage, UserMessage } from "./message.ts";
import { BadgedEditor } from "./badge.ts";
import { createChatLayout, createMainScreenLayout } from "./chat-layout.ts";
import type { CommandDescriptor, ModelInfo, SkillInfo } from "../rpc/protocol.ts";
import { Rule } from "./rule.ts";
import type { TurnStateMachine } from "./state.ts";

const colorMode = getTerminalColorMode();

// parseColor 不接受命名色（"white" 会抛错），用 hex。
/** 浅灰框线（消息分隔 / 用户条形框 / 输入框边框），比纯白淡。 */
const frame = parseColor("#a0a0a0");
/** 选中态 / 强调文字用纯白。 */
const white = parseColor("#ffffff");
const gray = parseColor("#808080");

const editorTheme: EditorTheme = {
  borderColor: (str) => styleText(str, { fg: frame }, colorMode),
  selectList: {
    selectedPrefix: (t) => styleText(t, { fg: white, bold: true }, colorMode),
    selectedText: (t) => styleText(t, { fg: white, bold: true }, colorMode),
    description: (t) => styleText(t, { fg: gray }, colorMode),
    scrollInfo: (t) => styleText(t, { dim: true }, colorMode),
    noMatch: (t) => styleText(t, { fg: gray }, colorMode),
  },
};

export type ChatTui = TuiAltScreen | TuiMainScreen;

export class ChatView {
  private readonly tui: ChatTui;
  private readonly transcript: Container;
  private readonly banner: Text;
  private readonly status: Text;
  private readonly editor: Editor;
  /** 带下方独立徽标行的输入框包装（挂载到组件树，键盘/鼠标委托给内层 editor）。 */
  private readonly badgedEditor: BadgedEditor;
  private readonly onSubmit: (text: string) => void;

  private assistant: AssistantMessage | null = null;
  private renderedTurnId = 0;
  private renderedCommandSeq = 0;

  constructor(tui: ChatTui, onSubmit: (text: string) => void) {
    this.tui = tui;
    this.onSubmit = onSubmit;

    this.transcript = new Container();
    this.banner = new Text("", 1, 0);
    this.status = new Text("", 1, 0);

    // 命令模式输入：Editor 自带斜杠菜单（行首 `/` 自动弹出 + Tab/Enter 选择），Enter 提交、Shift+Enter 换行。
    this.editor = new Editor(tui, editorTheme);
    this.badgedEditor = new BadgedEditor(this.editor);
    this.editor.onSubmit = (value) => {
      const text = value.trim();
      if (!text) return;
      this.onSubmit(text);
    };

    const parts = {
      transcript: this.transcript,
      banner: this.banner,
      status: this.status,
      editor: this.badgedEditor,
    };
    if (tui instanceof TuiAltScreen) {
      // 现代终端：全屏 alt-screen 视口 —— transcript 滚动区在上、dock 固定在底部。
      const { root } = createChatLayout(parts);
      tui.setLayoutRoot(root);
    } else {
      // 经典 conhost（cmd）：主缓冲 + conhost 原生 scrollback，滚轮由控制台处理。
      const { root } = createMainScreenLayout(parts);
      tui.addChild(root);
    }
  }

  /** 聚焦输入框（内层 Editor；键盘输入直接走聚焦组件，不经包装）。 */
  focusInput(): void {
    this.tui.setFocus(this.editor);
  }

  /** 安装命令补全（ready 握手后调用）：后端命令 + skills（skill:<名> 形态）+ /model /skill 参数补全。 */
  setAutocomplete(commands: CommandDescriptor[], skills: SkillInfo[], models: ModelInfo[]): void {
    const skillItems: AutocompleteItem[] = skills.map((s) => ({
      value: `skill:${s.name}`,
      label: s.name,
      description: s.description,
    }));
    const skillCommand: SlashCommand = {
      name: "skill",
      description: "激活/停用 skill；带参数一次性执行",
      argumentHint: "<名称> [参数]",
      getArgumentCompletions: (prefix) =>
        skills
          .filter((s) => !prefix || s.name.includes(prefix))
          .map((s) => ({ value: s.name, label: s.name, description: s.description })),
    };
    const commandEntries: SlashCommand[] = commands.map((c) => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argument_hint,
      // /model <Tab>：从模型目录补全可切换的模型名。
      ...(c.name === "model"
        ? {
            getArgumentCompletions: (prefix: string) =>
              models
                .filter((m) => !prefix || m.id.includes(prefix))
                .map((m) => ({ value: m.id, label: m.id, description: m.name })),
          }
        : {}),
    }));
    // CombinedAutocompleteProvider 对 `skill:<名>` 条目先按剥名、再按全名模糊匹配（autocomplete.js），
    // 因此 `/` 列出全部 skills+命令，`/m` 等前缀即模糊命中。
    const provider = new CombinedAutocompleteProvider([...commandEntries, skillCommand, ...skillItems], process.cwd());
    this.editor.setAutocompleteProvider(provider);
  }

  /**
   * 追加一条对话框。用户消息自带浅灰条框（上/下边），不再补分隔线；非用户对话框仅在上一个
   * 对话框不是用户消息时补分隔线（避免与条框重线）。视口底部由输入框上边框收尾（无 finalRule，
   * 避免与 Editor 边框叠出双线）。
   */
  private appendDialog(component: Component): void {
    const boxed = component instanceof UserMessage;
    const prev = this.transcript.children[this.transcript.children.length - 1];
    if (!boxed && !(prev instanceof UserMessage) && this.transcript.children.length > 0) {
      this.transcript.addChild(new Rule());
    }
    this.transcript.addChild(component);
  }

  /** 把状态机的视图模型同步到组件树，并请求重绘。 */
  sync(state: TurnStateMachine): void {
    const turn = state.current;
    if (turn && turn.id !== this.renderedTurnId) {
      // 新回合：追加用户消息 + 新建助手消息。
      this.appendDialog(new UserMessage(turn.userMessage));
      this.assistant = new AssistantMessage();
      this.appendDialog(this.assistant);
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
        this.appendDialog(new UserMessage(state.commandInput));
      }
      if (state.commandOutput) {
        this.appendDialog(new SystemMessage(state.commandOutput));
      }
    }
    this.banner.setText(state.errorBanner ?? "");
    this.status.setText(state.statusText);
    // 右键角徽标：当前模型 · 强度（ready 握手即写入，启动时 view.sync 立即显示）。
    this.badgedEditor.setBadge(state.modelLabel());
    this.tui.requestRender();
  }
}