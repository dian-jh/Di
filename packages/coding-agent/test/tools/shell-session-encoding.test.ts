import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellSession } from "@di/coding-agent";
import { createLegacyEncoder, discoverOemCodePage } from "../../src/core/tools/encoding.ts";

test("cmd input encoders preserve OEM bytes and reject unavailable pages", () => {
  const gbk = createLegacyEncoder(936);
  assert.ok(gbk);
  assert.equal(Buffer.from(gbk("中文")).toString("hex"), "d6d0cec4");
  const cp437 = createLegacyEncoder(437);
  assert.ok(cp437);
  assert.equal(Buffer.from(cp437("é")).toString("hex"), "82");
  assert.throws(() => cp437("中文"), /cannot be represented by code page 437/);
  const utf8 = createLegacyEncoder(65001);
  assert.ok(utf8);
  assert.equal(Buffer.from(utf8("中文")).toString("hex"), "e4b8ade69687");
  assert.equal(createLegacyEncoder(99999), undefined);
});

test("persistent cmd never silently replaces Unicode outside its OEM code page", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "di-cmd-encoding-"));
  const target = join(root, "中文目录");
  const asciiTarget = join(root, "ASCII");
  await mkdir(target);
  await mkdir(asciiTarget);
  const codePage = await discoverOemCodePage();
  assert.ok(codePage !== undefined);
  const canEncodeChinese = createLegacyEncoder(codePage);
  assert.ok(canEncodeChinese);
  let canEncode = true;
  try {
    canEncodeChinese("中文");
  } catch {
    canEncode = false;
  }
  const session = new ShellSession(root);
  try {
    const changed = await session.execute('cd "中文目录"', 10_000);
    if (!canEncode) {
      assert.equal(changed.exitCode, -1, changed.toObservation());
      assert.match(changed.error ?? "", new RegExp(`OEM 代码页 ${codePage}.*PowerShell`));
      const asciiChanged = await session.execute('cd "ASCII"', 10_000);
      assert.equal(asciiChanged.exitCode, 0, asciiChanged.toObservation());
      const current = await session.execute("cd", 10_000);
      assert.ok(current.toObservation().includes(asciiTarget), current.toObservation());
      return;
    }
    assert.equal(changed.exitCode, 0, changed.toObservation());
    const current = await session.execute("cd", 10_000);
    assert.ok(current.toObservation().includes(target), current.toObservation());
  } finally {
    session.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});
