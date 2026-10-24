import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";

import { ChatView } from "../src/app/chat-view.ts";
import { TurnStateMachine } from "../src/app/state.ts";
import { startInteractiveScreen } from "../src/app/terminal-mode.ts";

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  input?: (data: string) => void;
  output = "";
  start(onInput: (data: string) => void): void { this.input = onInput; }
  stop(): void {}
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(data: string): void { this.output += data; }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(): void {}
  send(data: string): void { this.input?.(data); }
}

class ResettingMouseTerminal extends FakeTerminal {
  mouseReporting = false;
  override start(onInput: (data: string) => void): void {
    super.start(onInput);
    // Windows raw-input setup can clear reporting enabled before terminal.start().
    this.mouseReporting = false;
  }
  override write(data: string): void {
    super.write(data);
    for (const mode of data.matchAll(/\x1b\[\?100[023]([hl])/g)) {
      this.mouseReporting = mode[1] === "h";
    }
  }
  override send(data: string): void {
    if (this.mouseReporting) super.send(data);
  }
}

describe("Windows mouse reporting after input initialization", () => {
  it("keeps Thinking clickable when raw-input setup clears earlier reporting", () => {
    const terminal = new ResettingMouseTerminal();
    const tui = new TuiAltScreen(terminal, undefined, undefined, { mouse: true });
    const state = new TurnStateMachine();
    const view = new ChatView(tui, () => {});
    state.startTurn("prompt");
    state.applyEvent({ kind: "reasoning_delta", delta: "probe reasoning" });
    view.sync(state);
    startInteractiveScreen(tui, "win32");
    view.focusInput();
    tui.renderNow(true);
    try {
      const row = tui.getScreenLines().findIndex(line => line.includes("Thinking")) + 1;
      assert.ok(row > 0);
      terminal.send(`\x1b[<0;2;${row}M`);
      terminal.send(`\x1b[<0;2;${row}m`);
      tui.renderNow(true);
      assert.ok(tui.getScreenLines().some(line => line.includes("probe reasoning")));
    } finally {
      tui.stop();
    }
    assert.equal(terminal.mouseReporting, false, "exit must disable mouse reporting");
  });
});

describe("alternate-screen mouse input", () => {
  it("selects and copies answer text without collapsing the turn", async () => {
    const terminal = new FakeTerminal();
    const copied: string[] = [];
    const tui = new TuiAltScreen(terminal, undefined, undefined, {
      mouse: true,
      copySelection: async (text) => { copied.push(text); return true; },
    });
    const state = new TurnStateMachine();
    const view = new ChatView(tui, () => {});
    state.startTurn("prompt");
    state.applyEvent({ kind: "text_delta", delta: "selectable answer" });
    view.sync(state);
    tui.start();
    view.focusInput();
    tui.renderNow(true);
    try {
      const lines = tui.getScreenLines().map(line => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
      const row = lines.findIndex(line => line.includes("selectable answer"));
      assert.ok(row >= 0);
      const col = lines[row]!.indexOf("selectable");
      terminal.send(`\x1b[<0;${col + 1};${row + 1}M`);
      terminal.send(`\x1b[<32;${col + 10};${row + 1}M`);
      terminal.send(`\x1b[<0;${col + 10};${row + 1}m`);
      await Promise.resolve();
      assert.equal(tui.hasActiveSelection(), true);
      assert.deepEqual(copied, ["selectable"]);
      tui.renderNow(true);
      assert.ok(tui.getScreenLines().some(line => line.includes("answer")));
    } finally {
      tui.stop();
    }
  });

  it("dispatches complete SGR click pairs repeatedly without focusing away from the editor", () => {
    const terminal = new FakeTerminal();
    const tui = new TuiAltScreen(terminal, undefined, undefined, { mouse: true });
    const state = new TurnStateMachine();
    const view = new ChatView(tui, () => {});
    state.startTurn("prompt");
    state.applyEvent({ kind: "reasoning_delta", delta: "private reasoning" });
    state.applyEvent({ kind: "tool_call_delta", id: "tool1", name: "shell", arguments: '{"cmd":"echo hi"}' });
    state.applyEvent({ kind: "tool_completed", call: { id: "tool1", name: "shell", arguments: '{"cmd":"echo hi"}' }, observation: "tool result", is_error: false });
    state.applyEvent({ kind: "text_delta", delta: "public answer" });
    view.sync(state);
    tui.start();
    view.focusInput();
    tui.renderNow(true);

    const screenText = () => tui.getScreenLines().join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const rowFor = (needle: string) => {
      const row = tui.getScreenLines().findIndex((line) => line.includes(needle));
      assert.notEqual(row, -1, `${needle} must be present on screen`);
      return row + 1;
    };
    const clickAtRow = (row: number) => {
      // Exercise independent clicks rather than a rapid double/triple-click selection.
      tui.resetTextSelection();
      terminal.send(`\x1b[<0;2;${row}M`);
      terminal.send(`\x1b[<0;2;${row}m`);
      tui.renderNow(true);
    };
    const mouseAt = (button: number, x: number, row: number, release = false) =>
      terminal.send(`\x1b[<${button};${x};${row}${release ? "m" : "M"}`);
    const clickLabel = (needle: string) => clickAtRow(rowFor(needle));

    try {
      assert.ok(!screenText().includes("private reasoning"));
      assert.ok(!screenText().includes("tool result"));
      const originalFocus = tui.getFocusedComponent();
      const initialThinkingRow = rowFor("Thinking");
      mouseAt(2, 2, initialThinkingRow);
      mouseAt(2, 2, initialThinkingRow, true);
      tui.renderNow(true);
      assert.ok(!screenText().includes("private reasoning"), "right click must not toggle Thinking");
      mouseAt(0, 2, initialThinkingRow);
      mouseAt(32, 3, initialThinkingRow);
      mouseAt(0, 3, initialThinkingRow, true);
      tui.renderNow(true);
      assert.ok(!screenText().includes("private reasoning"), "dragging must not synthesize a fold click");
      for (let i = 0; i < 4; i++) {
        clickLabel("Thinking");
        assert.equal(screenText().includes("private reasoning"), i % 2 === 0, `toggle ${i + 1}`);
        assert.equal(tui.getFocusedComponent(), originalFocus, "mouse fold click must not steal editor focus");
      }
      clickLabel("shell");
      assert.ok(screenText().includes("tool result"), "full SGR pair should expand tool result");
      clickLabel("shell");
      assert.ok(!screenText().includes("tool result"), "a second full SGR pair should collapse tool result");
      assert.ok(screenText().includes("public answer"));
      assert.equal((screenText().match(/prompt/g) ?? []).length, 1);
    } finally {
      tui.stop();
    }
  });
});
