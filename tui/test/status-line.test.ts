import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatStatusLine } from "../src/app/chat-view.ts";

describe("formatStatusLine", () => {
  for (const width of [1, 42, 100]) {
    it(`fits one terminal row at ${width} columns`, () => {
      const line = formatStatusLine("Cache: 85.2% | Cost: $0.0123", "deepseek-flash", width);
      assert.equal(visibleWidth(line), width);
      assert.equal(line.split("\n").length, 1);
    });
  }
});
