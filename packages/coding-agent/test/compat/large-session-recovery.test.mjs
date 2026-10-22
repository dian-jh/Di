import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { constants as bufferConstants } from "node:buffer";
import { SessionStore } from "../../src/core/sessions/session-log.ts";
import { loadRecovery } from "../../src/core/sessions/session-recovery.ts";

test("recovery preserves UTF-8 across chunk boundaries and ignores only the torn final record", () => {
  const root = mkdtempSync(join(tmpdir(), "di-recovery-utf8-"));
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("boundary 雪", Date.now());
    const bytes = readFileSync(store.logFilePath);
    const unicodeOffset = bytes.indexOf(Buffer.from("雪"));
    assert.ok(unicodeOffset >= 0);
    const padding = (65535 - (unicodeOffset + 3) % 65536 + 65536) % 65536;
    writeFileSync(store.logFilePath, Buffer.concat([Buffer.from("\ufeff" + " ".repeat(padding)), bytes, Buffer.from('{"torn":"雪')]));
    const messages = loadRecovery(store.logFilePath);
    assert.equal(messages[0]?.content[0]?.text, "boundary 雪");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("session recovery validates a log beyond the runtime string limit without retaining the whole file", () => {
  const root = mkdtempSync(join(tmpdir(), "di-large-recovery-"));
  try {
    const store = new SessionStore({ rootDirectory: root });
    store.beginCheckpointTurn("recover the final turn", Date.now());
    store.completeCheckpointTurn({ stopReason: "Completed", iterations: 1 });
    const fd = openSync(store.logFilePath, "a");
    try {
      // Legal blank lines separate complete records; none may accumulate in memory.
      const block = Buffer.from(" ".repeat(65535) + "\n");
      for (let i = 0; i <= Math.ceil(bufferConstants.MAX_STRING_LENGTH / block.length); i++) writeSync(fd, block);
    } finally { closeSync(fd); }
    const reader = new URL("../../src/core/sessions/session-recovery.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--max-old-space-size=48", "--input-type=module", "--eval",
      `import {loadRecovery} from ${JSON.stringify(reader)}; const messages = loadRecovery(process.argv[1]); if (messages.length !== 1 || messages[0].role !== 'user') process.exit(2); console.log('RECOVERED');`,
      store.logFilePath], { encoding: "utf8", timeout: 30_000, windowsHide: true, maxBuffer: 65536 });
    assert.equal(child.status, 0, `${child.error ?? ""}\n${child.stderr}`);
    assert.match(child.stdout, /RECOVERED/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
