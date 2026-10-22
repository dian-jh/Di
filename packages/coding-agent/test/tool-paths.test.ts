import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToolPath } from "../src/core/tools/paths.ts";

test("tool output keeps literal backslashes in POSIX file names", () => {
  assert.equal(normalizeToolPath("nested/literal\\name.txt", "/"), "nested/literal\\name.txt");
});

test("tool output converts Windows directory separators to slashes", () => {
  assert.equal(normalizeToolPath("nested\\file.txt", "\\"), "nested/file.txt");
});
