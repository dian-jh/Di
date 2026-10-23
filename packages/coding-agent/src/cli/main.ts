#!/usr/bin/env node
/*
 * CLI bin entry (/): the production executable main the `"bin"` field
 * points at — `di-ts` → `packages/coding-agent/dist/cli/main.js` (architecture.md
 * §7 / §141-147). The TS command never occupies the plain `di` name, so the
 * installed `di` stays the system default until migration completion. Also the
 * entry the TS TUI spawns as `process.execPath <this entry> --mode rpc`
 * (-tui-launcher-seam / RPC launcher). Parses argv, wraps the real stdio
 * into the injected `TextReader` / `TextWriter` seams, and dispatches
 * `CliApp.runAsync`.
 *
 * The dispatch shell never touches the console itself (
 * counterpart): TTY detection comes from the live stdio streams, data → stdout,
 * diagnostics → stderr, exit code 0/1. After the mode body the stdin reader is
 * closed so a clean RPC shutdown / EOF exits naturally (no lingering readline
 * handle); the host's dispose chain (`di exiting`) has already run inside
 * `runAsync`.
 */

import { CliApp } from "./cli-app.ts";
import { createStdinReader, type TextWriter } from "./io.ts";

const args = process.argv.slice(2);
const stdin = createStdinReader(process.stdin);
const stdout: TextWriter = {
  write(text: string): void {
    process.stdout.write(text);
  },
  writeLine(text = ""): void {
    process.stdout.write(text + "\n");
  },
};
const stderr: TextWriter = {
  write(text: string): void {
    process.stderr.write(text);
  },
  writeLine(text = ""): void {
    process.stderr.write(text + "\n");
  },
};
const stdinTty = process.stdin.isTTY === true;
const stdoutTty = process.stdout.isTTY === true;

const app = new CliApp();
try {
  const exitCode = await app.runAsync(args, stdin, stdout, stderr, stdinTty, stdoutTty);
  process.exitCode = exitCode;
} catch (error) {
  stderr.writeLine(`✗ 未处理的 CLI 错误: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  stdin.close();
}
