import test from "node:test";
import assert from "node:assert/strict";

import { ConfigParseError, parseJsonc, parseJsonObject } from "@di/coding-agent";

/**
 * JSONC parsing (P6.1 card 1). Config files follow the C# baseline where they are
 * parsed with .NET's JsonConfigurationProvider, which tolerates comments and
 * trailing commas. A pinned JSONC parser is required — regex comment stripping
 * or strict JSON.parse must NOT be used (operator-guide new-dependency rule).
 */
test("parseJsonc accepts comments and trailing commas", () => {
  const value = parseJsonc(
    `{
      // line comment
      "a": 1,
      "b": "x", /* block */
      "c": true,
    }`,
    "synthetic",
  );
  assert.deepEqual(value, { a: 1, b: "x", c: true });
});

test("parseJsonc preserves number, boolean and null values", () => {
  const value = parseJsonc('{"n": 12, "f": 0.4, "b": false, "z": null}', "synthetic");
  assert.deepEqual(value, { n: 12, f: 0.4, b: false, z: null });
});

test("parseJsonc throws ConfigParseError on syntax errors", () => {
  assert.throws(
    () => parseJsonc('{"a": }', "broken.jsonc"),
    (error: unknown) => {
      assert.ok(error instanceof ConfigParseError);
      assert.equal(error.source, "broken.jsonc");
      return true;
    },
  );
});

test("parseJsonObject rejects a non-object root", () => {
  assert.throws(
    () => parseJsonObject("[1, 2]", "array.jsonc"),
    (error: unknown) => {
      assert.ok(error instanceof ConfigParseError);
      return true;
    },
  );
});
