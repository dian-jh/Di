import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentMessage, ContentBlock, ToolCall } from "@di/ai";
import { textOfMessage } from "@di/ai";
import { loadRecovery, SessionDataError } from "@di/coding-agent";

function isToolCall(block: ContentBlock): block is ToolCall {
  return block.type === "tool-call";
}

/**
 *
 * §"Fixture 的构造与精确预期"). Each fixture directory carries a manifest.json with
 * `input_file` / `expected_status` / `expected_messages` / `expected_error_class` /
 * `expected_error_mentions` / `expected_model_calls` / `expected_executor_calls` /
 *
 * leaf contract — never generated from a fresh TS writer output.
 *
 * loadRecovery is pure file reading: it must NEVER invoke a model or an executor,
 * and the fixture reader asserts model_calls/executor_calls/side_effect_count are
 * all zero by construction.
 */

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/sessions", import.meta.url));

interface Manifest {
  input_file: string;
  expected_status: string;
  expected_error_class: string | null;
  expected_error_mentions: string[];
  expected_messages: Array<Record<string, unknown>>;
  expected_model_calls: number;
  expected_executor_calls: number;
  expected_side_effect_count: number;
}

const ERROR_CODE_TO_CLASS: Record<string, string> = {
  "unknown-outcome": "reject_unknown_outcome",
  "no-checkpoint": "reject_legacy_no_checkpoint",
  corrupt: "reject_corrupt",
  "unknown-record": "reject_unknown_record",
  "unknown-block": "reject_unknown_block",
};

function matchMessage(message: AgentMessage, expectation: Record<string, unknown>): boolean {
  if (expectation.role !== undefined && message.role !== expectation.role) return false;
  if (expectation.text !== undefined && textOfMessage(message) !== expectation.text) return false;
  if (expectation.call_id !== undefined) {
    if (message.role === "tool") {
      if (message.toolCallId !== expectation.call_id) return false;
    } else if (message.role === "assistant") {
      const call = message.content.find((b) => isToolCall(b) && b.id === expectation.call_id);
      if (call === undefined || !isToolCall(call)) return false;
      if (expectation.name !== undefined && call.name !== expectation.name) return false;
      if (expectation.args !== undefined && call.arguments !== expectation.args) return false;
    } else {
      return false;
    }
  }
  if (expectation.is_error !== undefined && message.role === "tool" && message.isError !== expectation.is_error) {
    return false;
  }
  return true;
}

const fixtureDirs = readdirSync(FIXTURES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

for (const dir of fixtureDirs) {
  test(`session fixture "${dir}" matches its manifest`, () => {
    const manifestPath = join(FIXTURES_DIR, dir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    const input = join(FIXTURES_DIR, dir, manifest.input_file);

    if (manifest.expected_error_class === null) {
      const trajectory = loadRecovery(input);
      for (const expectation of manifest.expected_messages) {
        const matched = trajectory.some((message) => matchMessage(message, expectation));
        assert.ok(matched, `no recovered message matches ${JSON.stringify(expectation)}`);
      }
      assert.equal(manifest.expected_model_calls, 0, "recovery never calls a model");
      assert.equal(manifest.expected_executor_calls, 0, "recovery never executes a tool");
      assert.equal(manifest.expected_side_effect_count, 0, "recovery never produces side effects");
      return;
    }

    assert.throws(
      () => loadRecovery(input),
      (error: unknown) => {
        assert.ok(error instanceof SessionDataError, `expected a SessionDataError, got ${String(error)}`);
        const expectedCode = Object.entries(ERROR_CODE_TO_CLASS).find(([, cls]) => cls === manifest.expected_error_class)?.[0];
        assert.ok(expectedCode !== undefined, `no mapping for expected_error_class ${manifest.expected_error_class}`);
        assert.equal(error.code, expectedCode, `status ${manifest.expected_status}`);
        for (const mention of manifest.expected_error_mentions) {
          assert.ok(error.message.includes(mention), `error message must mention '${mention}': ${error.message}`);
        }
        return true;
      },
    );
  });
}
