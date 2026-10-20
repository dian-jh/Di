import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LineTextReader, SessionStore, StringTextWriter, nullTextReader } from "@di/coding-agent";
import type { ModelSelectionHost, TextReader, TurnRunner } from "@di/coding-agent";
import { runPrintMode } from "@di/coding-agent";
import { buildHost, FakeRunner, ErrorRunner, makeArgs, skill, ThrowingRunner } from "./test-host.ts";
import type { BuildHostOptions } from "./test-host.ts";

/**
 * P6.3c card — print mode (headless text single shot), port of C# `Di.Cli.Tests/modes/PrintModeTests.cs`
 * at baseline 09f4e08 (the text half; the JSON half lives in json-mode.test.ts). The fake host uses a
 * real event bus + fake runner: prompt source (positional / stdin), streaming render (working status +
 * reasoning only under a TTY), session log best-effort, and the pessimistic failure paths (empty prompt,
 * runner throw, StopReason.Error).
 */

async function run<T extends TurnRunner & ModelSelectionHost = FakeRunner>(
  args: Parameters<typeof makeArgs>[0],
  stdin: TextReader = nullTextReader,
  stdoutTty = false,
  hostOverrides: BuildHostOptions & { runner?: T } = {},
) {
  const stdout = new StringTextWriter();
  const stderr = new StringTextWriter();
  const { host, runner } = buildHost<T>(hostOverrides);
  const code = await runPrintMode(host, makeArgs(args), stdin, stdout, stderr, stdoutTty);
  return { code, stdout, stderr, runner };
}

test("Print_WithPositionalPrompt_RendersAnswer_ExitsZero", async () => {
  const { code, stdout, stderr, runner } = await run({ positionals: ["读一下 README"] });

  assert.equal(code, 0);
  assert.deepEqual(runner.messages, ["读一下 README"]);
  const text = stdout.text();
  assert.ok(text.includes("第 1 轮思考完成"), "事件经总线流式渲染");
  assert.ok(text.includes("回答: 读一下 README"), "最终回答（流式增量即答案）");
  assert.equal(stderr.text(), "");
});

test("Print_ReadsPromptFromStdin_WhenNoPositional", async () => {
  const { code, runner } = await run({}, new LineTextReader(["从管道来的提示词"]));

  assert.equal(code, 0);
  assert.deepEqual(runner.messages, ["从管道来的提示词"]);
});

test("Print_MultiplePositionals_JoinedWithSpace", async () => {
  const { code, runner } = await run({ positionals: ["读", "README", "前", "十行"] });

  assert.equal(code, 0);
  assert.deepEqual(runner.messages, ["读 README 前 十行"]);
});

test("Print_EmptyPrompt_ExitsOne_WritesError_DoesNotRunTurn", async () => {
  const { code, stdout, stderr, runner } = await run({});

  assert.equal(code, 1);
  assert.deepEqual(runner.messages, []);
  assert.ok(stderr.text().includes("缺少提示词"));
  assert.equal(stdout.text(), "");
});

test("Print_ModelFlag_OverridesCurrentModel", async () => {
  const { code, runner } = await run({ model: "deepseek-v4-pro", positionals: ["hi"] });

  assert.equal(code, 0);
  assert.equal(runner.currentModel, "deepseek-v4-pro");
});

test("Print_StdoutTty_ShowsWorkingStatusBeforeFirstOutput", async () => {
  const { code, stdout } = await run({ positionals: ["hi"] }, nullTextReader, true);

  assert.equal(code, 0);
  const text = stdout.text();
  assert.ok(text.includes("正在请求模型"), "真实终端等待模型首 token 期间有反馈");
  assert.ok(text.indexOf("正在请求模型") < text.indexOf("第 1 轮思考完成"), "状态行应先于首个回合输出出现");
});

test("Print_StdoutRedirected_OmitsWorkingStatus", async () => {
  // stdoutTty 缺省 false（管道 / 文件 / 脚本）：不得输出状态行污染捕获内容。
  const { code, stdout } = await run({ positionals: ["hi"] });

  assert.equal(code, 0);
  assert.ok(!stdout.text().includes("正在请求模型"));
});

test("Print_StdoutTty_RendersReasoningBeforeAnswer", async () => {
  const runner = new FakeRunner();
  runner.emitReasoning = true;
  const { code, stdout } = await run({ positionals: ["hi"] }, nullTextReader, true, { runner });

  assert.equal(code, 0);
  const text = stdout.text();
  assert.ok(text.includes("思考中"), "思考期不再是死屏：推理内容应实时渲染");
  assert.ok(text.includes("先想想为什么"));
  assert.ok(text.indexOf("先想想为什么") < text.indexOf("回答: hi"), "思考增量应渲染在最终回答之前");
});

test("Print_StdoutRedirected_OmitsReasoning", async () => {
  const runner = new FakeRunner();
  runner.emitReasoning = true;
  // stdoutTty 缺省 false：不得把推理内容混进捕获输出（完整推理文本在会话日志 JSONL 里）。
  const { code, stdout } = await run({ positionals: ["hi"] }, nullTextReader, false, { runner });

  assert.equal(code, 0);
  const text = stdout.text();
  assert.ok(!text.includes("先想想为什么"));
  assert.ok(text.includes("回答: hi"));
});

test("Print_RunnerThrows_ExitsOne_WritesErrorToStderr", async () => {
  const { code, stderr } = await run({ positionals: ["hi"] }, nullTextReader, false, { runner: new ThrowingRunner() });

  assert.equal(code, 1);
  assert.ok(stderr.text().includes("运行失败"));
});

test("Print_StopReasonError_ExitsOne_WritesCodeAndMessage", async () => {
  const { code, stderr } = await run({ positionals: ["hi"] }, nullTextReader, false, { runner: new ErrorRunner() });

  assert.equal(code, 1);
  assert.ok(stderr.text().includes("missing_credential"));
  assert.ok(stderr.text().includes("缺少 API Key"));
});

test("Print_WritesSessionLog_ByDefault", async () => {
  const root = mkdtempSync(join(tmpdir(), "di-print-session-"));
  try {
    const sessionStore = new SessionStore({ rootDirectory: root });
    const { code } = await run({ positionals: ["hi"] }, nullTextReader, false, { sessionStore });

    assert.equal(code, 0);
    const lines = readFileSync(sessionStore.logFilePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    assert.ok(JSON.parse(lines[0]!).type === "session_meta");
    assert.ok(JSON.parse(lines[lines.length - 1]!).payload.type === "task_complete");
    assert.ok(lines.length >= 4, "单发回合至少写 meta + task_started + turn_context + task_complete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Print_NoSession_SkipsWritingLog", async () => {
  const root = mkdtempSync(join(tmpdir(), "di-print-nosession-"));
  try {
    const sessionStore = new SessionStore({ rootDirectory: root });
    const { code } = await run({ positionals: ["hi"], noSession: true }, nullTextReader, false, { sessionStore });

    assert.equal(code, 0);
    // --no-session 不应创建会话文件（SessionStore 构造只建目录；模式整体跳过写盘）。
    let exists = false;
    try {
      exists = readFileSync(sessionStore.logFilePath, "utf8").length > 0;
    } catch {
      exists = false;
    }
    assert.ok(!exists, "--no-session 不应创建会话文件");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- skill 自动匹配（headless 与 REPL 同一共享计算） ----

test("Print_AutoActivatesMatchingSkill_SetsActiveSkills", async () => {
  const skills = [skill("backend-tests", "运行并修复后端测试（dotnet）。当用户要求运行测试、分析失败或修复测试时使用。", "1. dotnet build\n2. dotnet test")];
  const { code, runner } = await run({ positionals: ["跑一下后端测试"] }, nullTextReader, false, { skills });

  assert.equal(code, 0);
  assert.deepEqual(runner.activeSkills.map((s) => s.name), ["backend-tests"]);
});

test("Print_NoMatchingSkill_LeavesActiveSkillsEmpty", async () => {
  const skills = [skill("backend-tests", "运行并修复后端测试（dotnet）。当用户要求运行测试、分析失败或修复测试时使用。")];
  const { code, runner } = await run({ positionals: ["随便聊聊"] }, nullTextReader, false, { skills });

  assert.equal(code, 0);
  assert.deepEqual(runner.activeSkills.map((s) => s.name), []);
});
