import test from "node:test";
import assert from "node:assert/strict";
import {
  ModelReference,
  ModelSelection,
  ModelSelectionError,
  type ModelSelectionErrorCode,
} from "@di/coding-agent";
import { FakeAdapter, FakeModelService, RecordingHost } from "./commands/test-doubles.ts";

/**
 * P6.3a card — model selection (port of C# `ModelSelectionTests.cs` minus the
 * RPC-mode / DI-factory cases, which are P6.3b wiring): provider/model
 * resolution (unique ID, unique fragment, ambiguity error), refresh-failure
 * keeps the last snapshot, a failed switch never changes the current model, a
 * successful cross-provider switch resets the reasoning tier, and a busy
 * session rejects switching.
 */

function setup() {
  const service = new FakeModelService();
  const deepseek = new FakeAdapter("deepseek", [
    { id: "deepseek-flash", name: "Flash" },
    { id: "shared", name: "Shared" },
  ]);
  const chatgpt = new FakeAdapter("chatgpt", [
    {
      id: "account-model",
      name: "Account model",
      reasoning: {
        efforts: [
          { id: "none", name: "None" },
          { id: "low", name: "Low" },
          { id: "medium", name: "Medium" },
          { id: "high", name: "High" },
        ],
        defaultEffort: "low",
      },
    },
    { id: "shared", name: "Shared" },
  ]);
  service.register(deepseek);
  service.register(chatgpt);
  const host = new RecordingHost();
  const selection = new ModelSelection(service, host);
  return { service, host, selection, deepseek, chatgpt };
}

const rejectsWith = (code: ModelSelectionErrorCode) => (error: unknown) =>
  error instanceof ModelSelectionError && error.code === code;

test("select resolves provider and unique names", async () => {
  const { host, selection } = setup();

  let selected = await selection.select("chatgpt/account-model");
  assert.equal(selected.provider, "chatgpt");
  assert.equal(selected.id, "account-model");
  assert.equal(host.currentModel, "chatgpt/account-model");

  selected = await selection.select("ACCOUNT-MODEL");
  assert.equal(selected.provider, "chatgpt");
  assert.equal(selected.id, "account-model");
  assert.equal(host.currentModel, "chatgpt/account-model");

  selected = await selection.select("Account model");
  assert.equal(selected.provider, "chatgpt");
  assert.equal(selected.id, "account-model");
  assert.equal(host.currentModel, "chatgpt/account-model");

  await selection.select("deepseek/deepseek-flash");
  assert.equal(host.currentModel, "deepseek-flash");
});

test("select unique fragment match resolves", async () => {
  const { host, selection } = setup();

  const selected = await selection.select("account");

  assert.equal(selected.provider, "chatgpt");
  assert.equal(selected.id, "account-model");
  assert.equal(host.currentModel, "chatgpt/account-model");
});

test("invalid or ambiguous selection preserves current model", async () => {
  const { host, selection } = setup();

  const cases: [string, ModelSelectionErrorCode][] = [
    ["shared", "ambiguous"], // both providers share the id
    ["no-such-model", "not-found"],
    ["unknown/account-model", "not-found"],
    ["chatgpt/", "invalid-query"],
    ["", "invalid-query"],
  ];
  for (const [query, code] of cases) {
    await assert.rejects(() => selection.select(query), rejectsWith(code));
    assert.equal(host.currentModel, "deepseek-flash");
  }
});

test("missing auth preserves current model without refreshing", async () => {
  const { host, selection, chatgpt } = setup();
  chatgpt.configured = false;

  await assert.rejects(() => selection.select("chatgpt/account-model"), rejectsWith("missing-credential"));

  assert.equal(host.currentModel, "deepseek-flash");
  assert.equal(chatgpt.refreshes, 0);
});

test("provider switch resets reasoning tier only after success", async () => {
  const { service, chatgpt } = setup();
  const host = new RecordingHost();
  const selection = new ModelSelection(service, host, { reasoningEffort: "max" });

  chatgpt.configured = false;
  await assert.rejects(() => selection.select("chatgpt/account-model"), rejectsWith("missing-credential"));
  assert.equal(selection.reasoningEffort, "max");
  assert.deepEqual(host.reasoningChanges, []);

  chatgpt.configured = true;
  await selection.select("chatgpt/account-model");
  assert.equal(selection.reasoningEffort, undefined);
  assert.deepEqual(host.reasoningChanges, [null]);
});

test("qualified id allows models absent from advisory catalog", async () => {
  const { host, selection } = setup();

  await selection.select("chatgpt/new-model");

  assert.equal(host.currentModel, "chatgpt/new-model");
});

test("model reference preserves slashes inside opaque model ids", () => {
  const parsed = ModelReference.parse("chatgpt/org/model", "deepseek", ["chatgpt"]);
  assert.equal(parsed.provider, "chatgpt");
  assert.equal(parsed.id, "org/model");
  assert.equal(parsed.qualifiedId, "chatgpt/org/model");

  const parsed2 = ModelReference.parse("org/model", "deepseek", ["chatgpt"]);
  assert.equal(parsed2.provider, "deepseek");
  assert.equal(parsed2.id, "org/model");
});

test("busy session rejects switching", async () => {
  const { host, selection } = setup();
  host.busy = true;

  await assert.rejects(() => selection.select("chatgpt/account-model"), rejectsWith("busy"));
  assert.equal(host.currentModel, "deepseek-flash");

  await assert.rejects(() => selection.setReasoning("high"), rejectsWith("busy"));
  assert.deepEqual(host.reasoningChanges, []);
});

test("refresh success refreshes every configured provider", async () => {
  const { selection, deepseek, chatgpt } = setup();

  const errors = await selection.refresh();

  assert.deepEqual(errors, []);
  assert.equal(deepseek.refreshes, 1);
  assert.equal(chatgpt.refreshes, 1);
});

test("refresh skips providers without auth", async () => {
  const { selection, deepseek, chatgpt } = setup();
  chatgpt.configured = false;

  const errors = await selection.refresh();

  assert.deepEqual(errors, []);
  assert.equal(deepseek.refreshes, 1);
  assert.equal(chatgpt.refreshes, 0);
});

test("refresh failure keeps the last snapshot", async () => {
  const service = new FakeModelService();
  const adapter = new FakeAdapter("deepseek", [{ id: "deepseek-flash", name: "Flash" }]);
  adapter.refreshError = new Error("boom");
  service.register(adapter);
  const host = new RecordingHost();
  const selection = new ModelSelection(service, host);

  const errors = await selection.refresh();

  assert.equal(errors.length, 1);
  assert.ok(errors[0]!.includes("boom"));
  // the advisory catalog still exposes the previous snapshot
  assert.deepEqual(selection.list().map((m) => m.id), ["deepseek-flash"]);
});

test("thinking changes reasoning effort and supports default", async () => {
  const { selection } = setup();
  await selection.select("chatgpt/account-model");

  await selection.setReasoning("high");
  assert.equal(selection.reasoningEffort, "high");

  await assert.rejects(() => selection.setReasoning("banana"), rejectsWith("unsupported-reasoning"));
  assert.equal(selection.reasoningEffort, "high");

  await selection.setReasoning("default");
  assert.equal(selection.reasoningEffort, undefined);
});
