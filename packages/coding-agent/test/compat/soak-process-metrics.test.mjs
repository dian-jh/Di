import test from "node:test";
import assert from "node:assert/strict";

import { sampleProcessMetrics } from "../soak/process-metrics.mjs";

test("Windows soak diagnostics report native process memory and OS handle counts", { skip: process.platform !== "win32" }, () => {
  const sample = sampleProcessMetrics();
  assert.ok(sample.os_handle_count > 0);
  assert.ok(sample.working_set_bytes > 0);
  assert.ok(sample.peak_working_set_bytes >= sample.working_set_bytes);
  assert.ok(sample.private_bytes > 0);
  assert.equal(typeof sample.js_handle_count, "number");
  assert.ok(sample.v8_total_heap_size_bytes > 0);
  assert.ok(sample.v8_total_physical_size_bytes > 0);
  assert.ok(sample.v8_malloced_memory_bytes >= 0);
  assert.ok(sample.v8_peak_malloced_memory_bytes >= 0);
  assert.equal(sample.native_metrics_error, null);
});

test("unavailable native metrics fall back to null without exposing error details", () => {
  const sample = sampleProcessMetrics({
    platform: "win32",
    sampleWindows: () => { throw new Error("secret-token=C:\\private\\credentials.json"); },
  });
  assert.equal(sample.os_handle_count, null);
  assert.equal(sample.working_set_bytes, null);
  assert.equal(sample.peak_working_set_bytes, null);
  assert.equal(sample.private_bytes, null);
  assert.equal(sample.native_metrics_error, "native process metrics unavailable");
  assert.doesNotMatch(sample.native_metrics_error, /secret-token|credentials/);
  assert.equal(typeof sample.v8_total_heap_size_bytes, "number");
});

test("macOS proc_pidinfo provides OS handles and resident memory without guessed metrics", { skip: process.platform !== "darwin" }, () => {
  const sample = sampleProcessMetrics({ platform: "darwin" });
  assert.ok(sample.os_handle_count > 0);
  assert.ok(sample.working_set_bytes > 0);
  assert.equal(sample.peak_working_set_bytes, null);
  assert.equal(sample.private_bytes, null);
  assert.equal(sample.native_metrics_error, null);
});

test("unavailable macOS native helper falls back to null without exposing error details", () => {
  const sample = sampleProcessMetrics({
    platform: "darwin",
    sampleMac: () => { throw new Error("private-path=/secret/runtime/token"); },
  });
  assert.equal(sample.os_handle_count, null);
  assert.equal(sample.working_set_bytes, null);
  assert.equal(sample.peak_working_set_bytes, null);
  assert.equal(sample.private_bytes, null);
  assert.equal(sample.native_metrics_error, "native process metrics unavailable");
  assert.doesNotMatch(sample.native_metrics_error, /secret|token/);
});
