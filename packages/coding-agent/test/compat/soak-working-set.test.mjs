import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyWorkingSetEntries,
  inspectWorkingSet,
  parseInspectArgs,
} from "../../test/soak/inspect-working-set.mjs";

test("working-set classification conserves pages and bytes across shareability and region groups", () => {
  const result = classifyWorkingSetEntries([
    { shareable: true, shareCount: 2, regionType: "MEM_IMAGE" },
    { shareable: false, shareCount: 0, regionType: "MEM_PRIVATE" },
    { shareable: true, shareCount: 1, regionType: "MEM_MAPPED" },
    { shareable: false, shareCount: 0, regionType: "MEM_IMAGE" },
  ], 4096);

  assert.deepEqual(result, {
    pages: 4,
    bytes: 16_384,
    shareable: { pages: 2, bytes: 8192 },
    notShareable: { pages: 2, bytes: 8192 },
    shareCountPages: Object.assign(Object.create(null), { 0: 2, 1: 1, 2: 1 }),
    regions: Object.assign(Object.create(null), {
      MEM_IMAGE: { pages: 2, bytes: 8192, shareablePages: 1, notShareablePages: 1 },
      MEM_PRIVATE: { pages: 1, bytes: 4096, shareablePages: 0, notShareablePages: 1 },
      MEM_MAPPED: { pages: 1, bytes: 4096, shareablePages: 1, notShareablePages: 0 },
    }),
    sharedFlagMeaning: "PSAPI Shared bit means shareable, not proof of current cross-process sharing; ShareCount is a separate 3-bit field (0-7).",
  });
  assert.equal(Object.values(result.regions).reduce((sum, group) => sum + group.pages, 0), result.pages);
  assert.equal(Object.values(result.regions).reduce((sum, group) => sum + group.bytes, 0), result.bytes);
});

test("unknown memory types remain explicitly unknown", () => {
  const result = classifyWorkingSetEntries([
    { shareable: true, shareCount: 1, regionType: "UNKNOWN_0x800000" },
  ]);

  assert.equal(result.regions["UNKNOWN_0x800000"].pages, 1);
  assert.equal(result.regions.MEM_PRIVATE, undefined);
  assert.equal(result.regions.MEM_IMAGE, undefined);
});

test("--pid accepts only an explicit positive integer and defaults to self", () => {
  assert.deepEqual(parseInspectArgs([], 123), { pid: 123 });
  assert.deepEqual(parseInspectArgs(["--pid", "456"], 123), { pid: 456 });
  for (const args of [["--pid"], ["--pid", "0"], ["--pid", "-1"], ["--pid", "1.5"], ["--pid", "1x"], ["--pid", "4294967296"], ["--pid", "456", "--pid", "456"]]) {
    assert.throws(() => parseInspectArgs(args, 123), /positive integer/i);
  }
  assert.throws(() => parseInspectArgs(["--other"], 123), /unknown option/i);
});

test("inspect rejects invalid pids before any OS query", () => {
  assert.throws(() => inspectWorkingSet(0, { platform: "win32", arch: "x64" }), /positive integer/i);
});

test("inspect gives a clear error on non-Windows systems", () => {
  assert.throws(() => inspectWorkingSet(123, { platform: "linux", arch: "x64" }), /Windows only/i);
});

test("inspect rejects unsupported Windows architectures before loading native APIs", () => {
  assert.throws(() => inspectWorkingSet(123, { platform: "win32", arch: "arm64" }), /architecture.*x64/i);
});

test("Windows self smoke: QueryWorkingSet page and classifications conserve the snapshot", {
  skip: process.platform !== "win32" || process.arch !== "x64",
}, () => {
  const result = inspectWorkingSet();
  assert.ok(result.pages > 0 && result.pages < 10_000_000);
  assert.equal(result.shareable.pages + result.notShareable.pages, result.pages);
  assert.equal(result.shareable.bytes + result.notShareable.bytes, result.bytes);
  assert.equal(Object.values(result.regions).reduce((sum, group) => sum + group.pages, 0), result.pages);
  assert.equal(Object.values(result.regions).reduce((sum, group) => sum + group.bytes, 0), result.bytes);
  assert.equal(Object.values(result.regions).reduce((sum, group) => sum + group.shareablePages, 0), result.shareable.pages);
  assert.equal(Object.values(result.regions).reduce((sum, group) => sum + group.notShareablePages, 0), result.notShareable.pages);
  assert.equal(Object.values(result.shareCountPages).reduce((sum, pages) => sum + pages, 0), result.pages);
});
