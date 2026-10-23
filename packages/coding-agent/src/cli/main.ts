#!/usr/bin/env node
/*
 * Production executable registered as `di-ts` in this package's `bin` field.
 * The TUI also starts this entry with `--mode rpc`. It parses argv, wraps the
 * process stdio in the injected `TextReader` / `TextWriter` interfaces, and
 * dispatches to `CliApp.runAsync`.
 *
 * TTY detection comes from the live stdio streams, data goes to stdout,
 * diagnostics → stderr, exit code 0/1. After the mode body the stdin reader is
 * closed so a clean RPC shutdown / EOF exits naturally (no lingering readline
 * handle); the host's dispose chain has already run inside `runAsync`.
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
