/**
 * terminal-mode 单元测试：经典 conhost（cmd）与现代终端检测。
 * 纯函数（platform + env 注入），不依赖真实进程。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isClassicConhost } from "../src/app/terminal-mode.ts";

describe("isClassicConhost：经典 cmd 与 现代终端 判别", () => {
  it("win32 且无现代终端特征变量 → conhost", () => {
    assert.equal(isClassicConhost("win32", {}), true);
    assert.equal(isClassicConhost("win32", { TERM_PROGRAM: undefined }), true);
  });

  it("非 win32 → 不是 conhost", () => {
    assert.equal(isClassicConhost("linux", {}), false);
    assert.equal(isClassicConhost("darwin", {}), false);
  });

  it("Windows Terminal 设 WT_SESSION → 现代终端", () => {
    assert.equal(isClassicConhost("win32", { WT_SESSION: "1a2b3c" }), false);
  });

  it("VS Code / mintty 等设 TERM_PROGRAM → 现代终端", () => {
    assert.equal(isClassicConhost("win32", { TERM_PROGRAM: "vscode" }), false);
    assert.equal(isClassicConhost("win32", { TERM_PROGRAM: "mintty" }), false);
  });

  it("ConEmu 设 ConEmuANSI → 现代终端", () => {
    assert.equal(isClassicConhost("win32", { ConEmuANSI: "ON" }), false);
  });
});