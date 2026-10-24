/**
 * 消息组件测试：用户消息自带浅灰条形框（上/下框线，区分非用户输入）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";

import { AssistantMessage, SystemMessage, TurnGroup, UserMessage } from "../src/app/message.ts";
import { ToolCallView } from "../src/app/tool-call.ts";
import { SpacedBlock } from "../src/app/spacing.ts";

// Color mode follows the actual terminal/CI environment. The library reduces
// #373737 to xterm color 237 when truecolor is unavailable.
const grayBackground = /\x1b\[48;(?:2;55;55;55|5;237)m/;
const lightForeground = /\x1b\[38;(?:2;242;242;242|5;255)m/;
const mutedForeground = /\x1b\[38;(?:2;128;128;128|5;244)m/;
function assertMutedStyle(rendered: string, message: string): void {
  assert.match(rendered, mutedForeground, message);
}

describe("UserMessage：整行灰底", () => {
	it("使用 > 前缀、可读前景和填满宽度的灰底", () => {
		const lines = new UserMessage("你好").render(20);
		assert.equal(lines.length, 1);
		assert.ok(stripTerminalSequences(lines[0]!).includes("> 你好"));
		assert.equal(visibleWidth(lines[0]!), 20);
		assert.match(lines[0]!, grayBackground, "整行应使用 #373737 背景色（或终端调色板近似色）");
		assert.match(lines[0]!, lightForeground, "用户文字应使用高对比浅色");
  });

	it("256 色与真彩终端都保留浅色前景和灰色背景", async () => {
		const previous = getCapabilities();
		try {
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			const palette = await import("../src/app/message.ts?colorMode=256");
			const paletteLine = new palette.UserMessage("你好").render(20)[0]!;
			assert.match(paletteLine, lightForeground, "浅色前景应适配 256 色模式");
			assert.match(paletteLine, /\x1b\[48;5;237m/);

			setCapabilities({ images: null, trueColor: true, hyperlinks: false });
			const rgb = await import("../src/app/message.ts?colorMode=truecolor");
			const rgbLine = new rgb.UserMessage("你好").render(20)[0]!;
			assert.match(rgbLine, lightForeground);
			assert.match(rgbLine, /\x1b\[48;2;55;55;55m/);
		} finally {
			setCapabilities(previous);
		}
	});
	it("换行与 CJK 按终端列宽填底色", () => {
		const lines = new UserMessage("你好\nabcdefghijk").render(8);
		assert.ok(lines.length >= 3);
		assert.ok(lines.every((line) => visibleWidth(line) === 8));
		assert.ok(lines.every((line) => grayBackground.test(line)));
	});
});

describe("ToolCallView：默认折叠与键盘切换", () => {
  it("left-button press/release/click toggles reliably; right click does not", () => {
    const view = new ToolCallView();
    view.update({ id: "mouse", name: "shell", arguments: '{"cmd":"echo hi"}', status: "completed", observation: "output" });
    const event = (type: "press" | "release" | "click", button: "left" | "right" = "left") => ({
      type, button, x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 24,
      shift: false, alt: false, ctrl: false,
    } as const);
    const toggleWithPair = () => {
      const pressed = view.component.handleMouse?.(event("press"));
      assert.equal(pressed, undefined, "press remains available for text selection");
      view.component.handleMouse?.(event("release"));
      view.component.handleMouse?.(event("click"));
    };

    toggleWithPair();
    assert.match(stripTerminalSequences(view.component.render(80).join("\n")), /output/);
    toggleWithPair();
    assert.ok(!stripTerminalSequences(view.component.render(80).join("\n")).includes("output"));
    assert.equal(view.component.handleMouse?.(event("press", "right")), undefined);
  });

  it("默认隐藏参数/结果，Enter 展开后显示，再按 Enter 折叠", () => {
    const view = new ToolCallView();
    view.update({ id: "1", name: "read", arguments: '{"path":"x"}', status: "completed", observation: "contents" });
    const collapsed = stripTerminalSequences(view.component.render(80).join("\n"));
    assert.ok(!collapsed.includes("contents"));
    view.component.handleInput?.("\r");
    const expanded = view.component.render(80).join("\n");
    assert.match(stripTerminalSequences(expanded), /contents/);
    assertMutedStyle(expanded, "tool details should use a subdued explicit gray foreground");
    for (const line of expanded.split("\n").filter((line) => /read|args|contents/.test(stripTerminalSequences(line)))) {
      assertMutedStyle(line, "tool title, arguments, and result should all use the subdued foreground");
    }
    view.component.handleInput?.("\r");
    assert.ok(!stripTerminalSequences(view.component.render(80).join("\n")).includes("contents"));
  });

  it("折叠标题显示工具耗时，参数只在展开后显示", () => {
    const view = new ToolCallView();
    view.update({ id: "2", name: "shell", arguments: '{"cmd":"ok"}', status: "running" });
    view.update({ id: "2", name: "shell", arguments: '{"cmd":"ok"}', status: "completed", observation: "done" });
    const collapsed = stripTerminalSequences(view.component.render(80).join("\n"));
    assert.match(collapsed, /shell 0\.0s/);
    assert.ok(!collapsed.includes('"cmd"'));
    view.component.handleInput?.("\r");
    assert.match(stripTerminalSequences(view.component.render(80).join("\n")), /args \{"cmd":"ok"\}/);
  });
});

describe("SystemMessage：无框系统应答", () => {
  it("按行加 ‖ 前缀，无框线", () => {
    const lines = new SystemMessage("a\nb").render(20);
    assert.equal(lines.length, 2);
    assert.ok(stripTerminalSequences(lines[0]!).includes("‖ a"));
    assert.ok(stripTerminalSequences(lines[1]!).includes("‖ b"));
  });
});

describe("TurnGroup：历史回合独立折叠", () => {
  it("只折叠当前组；Enter 可重新展开", () => {
    const first = new TurnGroup([new Text("answer one")], "回合一");
    const second = new TurnGroup([new Text("answer two")], "回合二");
    first.handleInput("\r");
    assert.ok(!first.render(40).join("\n").includes("answer one"));
    assert.ok(second.render(40).join("\n").includes("answer two"));
    first.handleInput("\r");
    assert.ok(first.render(40).join("\n").includes("answer one"));
  });
});

describe("SpacedBlock：只为可见块留一个普通空行", () => {
  it("用户行之后的 thinking/answer 留空行，空 assistant 不制造空白", () => {
    const assistant = new AssistantMessage();
    const group = new TurnGroup([new UserMessage("prompt"), assistant], "spacing");
    assert.equal(group.render(30).length, 1);
    assistant.setReasoning("reason");
    const thinking = group.render(30).map(stripTerminalSequences);
    assertMutedStyle(group.render(30).join("\n"), "Thinking label should use subdued gray");
    assert.ok(thinking.includes(""), "用户灰条与思考标题之间应留普通背景空行");
    assistant.setAnswer("answer");
    const answerLine = group.render(30).find((line) => stripTerminalSequences(line).includes("answer"))!;
    assert.ok(!answerLine.includes("\x1b[38;2;128;128;128m") && !answerLine.includes("\x1b[38;5;244m"), "assistant answer should keep its normal foreground");
    const answer = group.render(30).map(stripTerminalSequences);
    const answerIndex = answer.findIndex((line) => line.includes("answer"));
    assert.ok(answerIndex > 0 && answer[answerIndex - 1] === "", "思考展开内容与答案之间应留空行");
    assistant.setAnswer("answer\ncontinued");
    assert.equal(group.render(30).filter((line) => stripTerminalSequences(line) === "").length, 2,
      "流式 setText 更新不能累计空行");
  });

  it("空块保持零行，鼠标坐标映射跳过插入的空白行", () => {
    const child = new Text("line", 0, 0);
    let receivedY = -1;
    child.handleMouse = (event) => { receivedY = event.y; return { handled: true, render: false }; };
    const spaced = new SpacedBlock(child);
    const rendered = spaced.render(20).map(stripTerminalSequences);
    assert.equal(rendered[0], "");
    assert.match(rendered[1]!, /^line/);
    spaced.handleMouse?.({ type: "click", button: "left", x: 0, y: 1, screenX: 0, screenY: 1, width: 20, height: 4, shift: false, alt: false, ctrl: false });
    assert.equal(receivedY, 0);
    assert.equal(new SpacedBlock(new Text("", 0, 0)).render(20).length, 0);
  });

  it("历史回合后留一行，首个回合不需要前置空白", () => {
    const first = new TurnGroup([new UserMessage("one")], "one");
    const second = new TurnGroup([new UserMessage("two")], "two");
    assert.equal(first.render(20).length, 1);
    const spaced = new SpacedBlock(second).render(20).map(stripTerminalSequences);
    assert.equal(spaced.length, 2);
    assert.equal(spaced[0], "");
    assert.match(spaced[1]!, /two/);
  });
});

describe("Thinking 折叠", () => {
  it("complete left-button press/release pairs toggle Thinking in both directions", () => {
    const assistant = new AssistantMessage();
    assistant.setReasoning("reasoning text");
    const group = new TurnGroup([new UserMessage("prompt"), assistant], "回合测试");
    const fold = assistant.children[0]!;
    const gesture = (type: "press" | "release" | "click", y: number, button: "left" | "right" = "left") => ({
      type, button, x: 0, y, screenX: 0, screenY: y, width: 80, height: 24,
      shift: false, alt: false, ctrl: false,
    } as const);

    const press1 = group.handleMouse(gesture("press", 2));
    assert.equal(press1, undefined, "press remains available for text selection");
    group.handleMouse(gesture("release", 2));
    group.handleMouse(gesture("click", 2));
    assert.ok(fold.render(80).join("\n").includes("reasoning text"));
    assertMutedStyle(fold.render(80).join("\n"), "expanded reasoning should use subdued gray");

    group.handleMouse(gesture("press", 2));
    group.handleMouse(gesture("release", 2));
    group.handleMouse(gesture("click", 2));
    assert.ok(!fold.render(80).join("\\n").includes("reasoning text"));

    assert.equal(group.handleMouse(gesture("press", 2, "right")), undefined, "right click must not capture a fold gesture");
  });

  it("reasoning foreground is restored after embedded ANSI resets", () => {
    const assistant = new AssistantMessage();
    assistant.setReasoning("before\x1b[0mafter");
    const fold = assistant.children[0]!;
    fold.handleInput?.("\r");
    const rendered = fold.render(80).join("\n");
    assert.match(rendered, new RegExp(`\\x1b\\[(?:0|39)?m${mutedForeground.source}[^\\n]*after`));
  });

  it("完成后折叠和展开保留冻结耗时", () => {
    const assistant = new AssistantMessage();
    assistant.setReasoning("reasoning");
    assistant.finishThinking();
    const fold = assistant.children[0]!;
    const first = stripTerminalSequences(fold.render(80).find((line) => stripTerminalSequences(line).includes("Thinking"))!);
    fold.handleInput?.("\r");
    fold.handleInput?.("\r");
    const after = stripTerminalSequences(fold.render(80).find((line) => stripTerminalSequences(line).includes("Thinking"))!);
    assert.match(first, /Thinking · \d+\.\d+s/);
    assert.equal(after, first);
  });
});
