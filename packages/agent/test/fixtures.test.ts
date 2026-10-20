import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { ToolCall } from "@di/ai";
import type { ToolObservation } from "@di/agent";

import {
  isLoopFixture,
  validateFixture,
  type Fixture,
  type LoopFixture,
} from "./fixture-schema.ts";
import { RecordingExecutor } from "./recording-executor.ts";

/**
 * Cross-language fixture tests (P1.2).
 *
 * Every fixture in the repo-root `fixtures/` directory must satisfy the
 * documented schema, and the tool-round-trip fixture must be drivable through
 * the recording executor to prove recording/replay works. Expected values are
 * derived from the C# baseline tests at 09f4e08 — never from generated output.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");

/** Minimal required scenario set per execution-plan.md P1 item 5. */
const REQUIRED_SCENARIOS = [
  "pure-answer",
  "tool-round-trip",
  "error",
  "soft-stop",
  "hard-cancel",
  "budget-pause",
  "recovery",
] as const;

function fixtureFiles(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith(".json") && name !== "schema.json")
    .sort();
}

function loadFixture(fileName: string): Fixture {
  const raw = readFileSync(path.join(FIXTURES_DIR, fileName), "utf8");
  return JSON.parse(raw) as Fixture;
}

function loadLoopFixture(fileName: string): LoopFixture {
  const fixture = loadFixture(fileName);
  assert.ok(isLoopFixture(fixture), `${fileName}: expected a loop fixture`);
  return fixture;
}

test("every fixture file validates against the documented schema", () => {
  const files = fixtureFiles();
  assert.ok(files.length >= REQUIRED_SCENARIOS.length, `expected at least ${REQUIRED_SCENARIOS.length} fixtures, found ${files.length}`);
  for (const file of files) {
    const fixture = loadFixture(file);
    const errors = validateFixture(fixture);
    assert.deepEqual(errors, [], `${file} should satisfy the fixture schema`);
  }
});

test("the required scenario set is covered by the fixtures", () => {
  const scenarios = new Set(fixtureFiles().map((file) => loadFixture(file).scenario));
  for (const scenario of REQUIRED_SCENARIOS) {
    assert.ok(scenarios.has(scenario), `missing required scenario: ${scenario}`);
  }
});

test("schema.json itself is parseable JSON", () => {
  const raw = readFileSync(path.join(FIXTURES_DIR, "schema.json"), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assert.ok(parsed !== null && typeof parsed === "object", "schema.json must be a JSON object");
});

test("tool-round-trip fixture drives the recording executor in order", async () => {
  const fixture = loadLoopFixture("tool-round-trip.json");
  const expectedCalls = fixture.expected.toolCalls;
  assert.ok(expectedCalls.length > 0, "tool-round-trip must exercise at least one tool call");

  // Canned results come straight from the fixture's expected observations.
  const canned = new Map<string, ToolObservation>();
  for (const expected of expectedCalls) {
    canned.set(expected.id, { text: expected.observation, isError: expected.isError });
  }
  const executor = new RecordingExecutor(
    (call) => canned.get(call.id) ?? { text: "unexpected call", isError: true },
  );

  // Replay the expected invocations in order.
  for (const expected of expectedCalls) {
    const call: ToolCall = {
      type: "tool-call",
      id: expected.id,
      name: expected.name,
      arguments: expected.arguments,
    };
    const observation = await executor.execute(call);
    assert.equal(observation.text, expected.observation, `observation text for ${expected.id}`);
    assert.equal(observation.isError, expected.isError, `isError for ${expected.id}`);
  }

  // Recording: same order, same id/name/raw arguments, no extra invocations.
  const recorded = executor.calls;
  assert.equal(recorded.length, expectedCalls.length, "executor must record exactly the expected calls");
  expectedCalls.forEach((expected, index) => {
    const call = recorded[index];
    assert.ok(call, `expected a recorded call at index ${index}`);
    assert.equal(call.id, expected.id);
    assert.equal(call.name, expected.name);
    assert.equal(call.arguments, expected.arguments);
  });

  // Order bookkeeping via records().
  const records = executor.records();
  assert.deepEqual(
    records.map((record) => record.order),
    expectedCalls.map((_, index) => index + 1),
    "recorded execution order must be 1..n",
  );
});
