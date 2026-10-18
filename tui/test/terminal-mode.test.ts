import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { terminalScreenMode } from "../src/app/terminal-mode.ts";

describe("terminalScreenMode", () => {
  it("uses the interactive scrollable screen when Windows Terminal markers are absent", () => {
    assert.equal(terminalScreenMode("win32", {}), "interactive");
  });

  it("uses the interactive scrollable screen across terminal environments", () => {
    assert.equal(terminalScreenMode("win32", { WT_SESSION: "session" }), "interactive");
    assert.equal(terminalScreenMode("linux", {}), "interactive");
  });
});
