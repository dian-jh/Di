import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellSession } from "@di/coding-agent";
import { createLegacyEncoder } from "../../src/core/tools/encoding.ts";

test("cmd input encoders preserve OEM bytes and reject unavailable pages", () => {
  const gbk = createLegacyEncoder(936);
  assert.ok(gbk);
  assert.equal(Buffer.from(gbk("中文")).toString("hex"), "d6d0cec4");
  const cp437 = createLegacyEncoder(437);
  assert.ok(cp437);
  assert.equal(Buffer.from(cp437("é")).toString("hex"), "82");
  const utf8 = createLegacyEncoder(65001);
  assert.ok(utf8);
  assert.equal(Buffer.from(utf8("中文")).toString("hex"), "e4b8ade69687");
  assert.equal(createLegacyEncoder(99999), undefined);
});

test("persistent cmd accepts a Chinese directory name on its stdin", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "di-cmd-encoding-"));
  const target = join(root, "中文目录");
  await mkdir(target);
  const session = new ShellSession(root);
  try {
    const changed = await session.execute('cd "中文目录"', 10_000);
    assert.equal(changed.exitCode, 0, changed.toObservation());
    const current = await session.execute("cd", 10_000);
    assert.ok(current.toObservation().includes(target), current.toObservation());
  } finally {
    session.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});
