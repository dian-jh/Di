import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentResult } from "@di/agent";
import {
  CliApp,
  LineTextReader,
  nullTextReader,
  SessionStore,
  StringTextWriter,
  type CliArgs,
  type CliHost,
  type Skill,
  type TextWriter,
  type TuiLauncherContext,
} from "@di/coding-agent";
import { FakeAdapter, FakeModelService } from "../commands/test-doubles.ts";
import { buildHost, FakeRunner } from "../modes/test-host.ts";

/**
 * P6.3b card — CliApp dispatch shell (port of the in-scope half of C#
 * `Di.Cli.Tests/cli/CliAppTests.cs` at baseline 09f4e08). Short paths
 * (--version / --help / --stats / arg errors) return before any host is built
 * and never touch DI/files; host-requiring paths (--list-models / --skill-eval)
 * go through an injected fake host factory. The interactive / print / json / rpc
 * BODIES are P6.3c, so the host-requiring dispatch seam is locked here with a
 * fail-closed "not yet implemented" for those modes and with the host-failure
 * envelope contract (json mode → stdout error doc; text modes → stderr).
 */

const TTY = true;

function setup(host: CliHost | null = null, tui?: TuiLauncherContext) {
  const stdout = new StringTextWriter();
  const stderr = new StringTextWriter();
  const factory = new HostFactory(host);
  const app = new CliApp(factory.create, tui);
  return { app, stdout, stderr, factory };
}

/** Fake host: a full P6.3c CliHost (models over a fake service + skills + runner + bus + registry). */
function makeHost(models: FakeModelService, skills: readonly Skill[]): CliHost {
  return buildHost({ service: models, skills }).host;
}

function deepseekModels() {
  const service = new FakeModelService();
  service.register(
    new FakeAdapter("deepseek", [
      { id: "deepseek-chat", name: "DeepSeek Chat" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ]),
  );
  return service;
}

// ---- short paths: no host ----

test("Version_PrintsSemver_ExitsZero_WithoutBuildingHost", async () => {
  const { app, stdout, stderr, factory } = setup();

  const code = await app.runAsync(["--version"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 0);
  assert.match(stdout.text().trim(), /^\d+\.\d+\.\d+/);
  assert.equal(stderr.text(), "");
  assert.equal(factory.calls, 0); // version path must not build a host
});

test("Info_PrintsEnvironmentAndEffectiveConfig_ExitsZero_WithoutBuildingHost", async () => {
  const { app, stdout, stderr, factory } = setup();

  const code = await app.runAsync(["--info"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 0);
  const text = stdout.text();
  assert.ok(text.includes("版本"));
  assert.ok(text.includes("生效配置"));
  assert.ok(text.includes("MaxIterations"));
  assert.ok(text.includes("DefaultModel"));
  assert.ok(text.includes("Shell 工具"));
  assert.equal(stderr.text(), "");
  assert.equal(factory.calls, 0); // info path must not build a host
});

test("Help_PrintsUsage_ExitsZero_WithoutBuildingHost", async () => {
  const { app, stdout, stderr, factory } = setup();

  const code = await app.runAsync(["--help"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 0);
  const text = stdout.text();
  assert.ok(text.includes("用法"));
  assert.ok(text.includes("--version"));
  assert.ok(text.includes("--model"));
  assert.equal(factory.calls, 0);
});

test("ShortHelp_PrintsUsage_ExitsZero", async () => {
  const { app, stdout, factory } = setup();

  const code = await app.runAsync(["-h"], nullTextReader, stdout, new StringTextWriter(), TTY, TTY);

  assert.equal(code, 0);
  assert.ok(stdout.text().includes("用法"));
  assert.equal(factory.calls, 0);
});

test("UnknownFlag_ErrorToStderr_ExitsOne_WithoutBuildingHost", async () => {
  const { app, stdout, stderr, factory } = setup();

  const code = await app.runAsync(["--bogus"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 1);
  assert.ok(stderr.text().includes("--bogus"));
  assert.equal(factory.calls, 0);
});

test("MissingValue_ErrorToStderr_ExitsOne", async () => {
  const { app, stdout, stderr, factory } = setup();

  const code = await app.runAsync(["--model"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 1);
  assert.ok(stderr.text().includes("缺少值"));
  assert.equal(factory.calls, 0);
});

test("InvalidMode_ErrorToStderr_ExitsOne", async () => {
  const { app, stdout, stderr, factory } = setup();

  const code = await app.runAsync(["--mode", "nope"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 1);
  assert.ok(stderr.text().includes("nope"));
  assert.equal(factory.calls, 0);
});

// ---- host-requiring paths: injected fake host ----

test("ListModels_PrintsModels_ExitsZero", async () => {
  const service = deepseekModels();
  const { app, stdout, stderr, factory } = setup(makeHost(service, []));

  const code = await app.runAsync(["--list-models"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 0);
  const text = stdout.text();
  assert.ok(text.includes("deepseek-chat"));
  assert.ok(text.includes("DeepSeek V4 Pro"));
  assert.equal(factory.calls, 1);
});

test("ListModels_WithPattern_FiltersByIdOrProvider", async () => {
  const service = deepseekModels();
  const { app, stdout, factory } = setup(makeHost(service, []));

  const code = await app.runAsync(["--list-models", "v4"], nullTextReader, stdout, new StringTextWriter(), TTY, TTY);

  assert.equal(code, 0);
  assert.ok(stdout.text().includes("deepseek-v4-pro"));
  assert.ok(!stdout.text().includes("deepseek-chat"));
});

test("ListModels_NoModels_PrintsHint_ExitsZero", async () => {
  const service = new FakeModelService();
  const { app, stdout, factory } = setup(makeHost(service, []));

  const code = await app.runAsync(["--list-models"], nullTextReader, stdout, new StringTextWriter(), TTY, TTY);

  assert.equal(code, 0);
  assert.ok(stdout.text().includes("无可用模型"));
});

// ---- --stats: offline aggregation, no host ----

test("Stats_WithSessionFile_PrintsSummary_ExitsZero_WithoutHost", async () => {
  const root = mkdtempSync(join(tmpdir(), "di-cli-stats-"));
  try {
    const store = new SessionStore({ rootDirectory: root });
    const result: AgentResult = {
      answer: "ok",
      trajectory: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      history: [],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 },
      iterations: 1,
      stopReason: "answer",
    };
    store.appendTurn(result, 1_700_000_000_000);
    const { app, stdout, stderr, factory } = setup();

    const code = await app.runAsync(["--stats", store.logFilePath], nullTextReader, stdout, stderr, TTY, TTY);

    assert.equal(code, 0);
    const text = stdout.text();
    assert.ok(text.includes("回合数: 1"));
    assert.ok(text.includes("缓存命中 900"));
    assert.ok(text.includes("命中率 90.0%"));
    assert.equal(stderr.text(), "");
    assert.equal(factory.calls, 0); // offline command never builds a host
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stats_MissingPath_ExitsOne_WithoutHost", async () => {
  const { app, stdout, stderr, factory } = setup();

  const code = await app.runAsync(["--stats"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 1);
  assert.ok(stderr.text().includes("缺少值"));
  assert.equal(factory.calls, 0);
});

test("Stats_FileNotFound_ExitsOne_WithoutHost", async () => {
  const { app, stdout, stderr, factory } = setup();

  const code = await app.runAsync(["--stats", "no-such-session.jsonl"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 1);
  assert.ok(stderr.text().includes("不存在"));
  assert.equal(factory.calls, 0);
});

// ---- --skill-eval: labeled case set evaluation (depends on the host's skills) ----

const BACKEND_TESTS_SKILL: Skill = {
  name: "backend-tests",
  description: "运行并修复后端测试（dotnet）。当用户要求运行测试、分析失败或修复测试时使用。",
  instructions: "1. dotnet build\n2. dotnet test",
  metadata: {},
  allowedTools: [],
  disableModelInvocation: false,
  directory: "",
};

test("SkillEval_WithCases_PrintsMetrics_ExitsZero", async () => {
  const casesPath = writeCases(`[
      { "message": "跑一下后端测试", "expected_skills": ["backend-tests"] },
      { "message": "随便聊聊", "expected_skills": [] }
    ]`);
  const service = new FakeModelService();
  const { app, stdout, stderr, factory } = setup(makeHost(service, [BACKEND_TESTS_SKILL]));

  const code = await app.runAsync(["--skill-eval", casesPath], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 0);
  const text = stdout.text();
  assert.ok(text.includes("用例数: 2"));
  assert.ok(text.includes("精确率: 1.000"));
  assert.ok(text.includes("召回率: 1.000"));
  assert.ok(text.includes("平均上下文 token/回合"));
  assert.equal(stderr.text(), "");
  assert.equal(factory.calls, 1); // skill-eval reuses the host's skill discovery
});

test("SkillEval_MissingPath_ExitsOne_WithoutHost", async () => {
  const { app, stdout, stderr, factory } = setup();

  const code = await app.runAsync(["--skill-eval"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 1);
  assert.ok(stderr.text().includes("缺少值"));
  assert.equal(factory.calls, 0);
});

test("SkillEval_NoCasesFile_ExitsOne", async () => {
  const service = new FakeModelService();
  const { app, stdout, stderr, factory } = setup(makeHost(service, []));

  const code = await app.runAsync(["--skill-eval", "no-such-cases.json"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 1);
  assert.ok(stderr.text().includes("无法加载用例文件"));
  assert.equal(factory.calls, 1);
});

// ---- host-failure output contract (the seam --resume's JSON envelope will use) ----

test("HostFactoryFailure_UsesJsonErrorEnvelopeInJsonMode", async () => {
  const { app, stdout, stderr, factory } = setup(); // no host: factory throws

  const code = await app.runAsync(["--mode", "json", "--list-models"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 1);
  assert.ok(stdout.text().includes('"error"'));
  assert.ok(stdout.text().includes("session_resume"));
  assert.equal(stderr.text(), "");
  assert.equal(factory.calls, 1);
});

test("HostFactoryFailure_ErrorToStderrInTextMode", async () => {
  const { app, stdout, stderr, factory } = setup(); // no host: factory throws

  const code = await app.runAsync(["--list-models"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 1);
  assert.ok(stderr.text().includes("无法启动 CLI"));
  assert.equal(stdout.text(), "");
  assert.equal(factory.calls, 1);
});

// ---- interactive / resume / rpc dispatch (P6.3c real mode bodies) ----

/** TUI context that forces the C# REPL fallback (interactive tests don't touch real env / fs / processes). */
const ReplOnly: TuiLauncherContext = { getEnv: () => "repl" };

test("Resume_UsesReplWithoutTryingTui", async () => {
  let spawnCalls = 0;
  const tui: TuiLauncherContext = {
    getEnv: () => "",
    resolveEntry: () => "fake-entry.js",
    nodeAvailable: () => true,
    spawn: () => {
      spawnCalls += 1;
      return 0;
    },
  };
  const { host } = buildHost();
  const { app, stdout, stderr, factory } = setup(host, tui);

  const code = await app.runAsync(["--resume", "checkpoint.jsonl"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 0);
  assert.equal(spawnCalls, 0); // --resume 强制简单交互（REPL），不尝试 TUI、不自动请求模型
  assert.equal(factory.calls, 1);
});

test("ResumeHostFailure_UsesJsonErrorEnvelopeInJsonMode", async () => {
  const { app, stdout, stderr, factory } = setup(); // no host: factory throws

  const code = await app.runAsync(["--mode", "json", "--resume", "broken.jsonl"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 1);
  assert.ok(stdout.text().includes('"error"'));
  assert.ok(stdout.text().includes("session_resume"));
  assert.equal(stderr.text(), "");
  assert.equal(factory.calls, 1);
});

test("RpcMode_BuildsHost_EmitsReady_ExitsZero", async () => {
  const { host } = buildHost();
  const { app, stdout, stderr, factory } = setup(host);
  const stdin = new LineTextReader(['{"type":"request","id":1,"method":"shutdown","params":{}}']);

  const code = await app.runAsync(["--mode", "rpc"], stdin, stdout, stderr, TTY, TTY);

  assert.equal(code, 0);
  assert.ok(stdout.text().includes('"type":"ready"'));
  assert.equal(stderr.text(), "");
  assert.equal(factory.calls, 1); // rpc 路径构建宿主
});

test("Json_Prompt_EmitsSingleDoc_ExitsZero", async () => {
  const { host } = buildHost();
  const { app, stdout, stderr, factory } = setup(host);

  const code = await app.runAsync(["--mode", "json", "分析"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 0);
  const doc = JSON.parse(stdout.text());
  assert.equal(doc.stop_reason, "answer");
  assert.equal(stderr.text(), "");
  assert.equal(factory.calls, 1);
});

test("Interactive_ReadsStdin_RunsAgentTurn", async () => {
  const { host, runner } = buildHost();
  const { app, stdout, stderr, factory } = setup(host, ReplOnly);
  const stdin = new LineTextReader(["你好", "/exit"]);

  const code = await app.runAsync([], stdin, stdout, stderr, TTY, TTY);

  assert.equal(code, 0);
  assert.deepEqual((runner as FakeRunner).messages, ["你好"]);
  assert.ok(stdout.text().includes("di>"));
  assert.ok(stdout.text().includes("回答: 你好"));
  assert.equal(factory.calls, 1);
});

test("Interactive_StdinEof_ExitsZero_WithoutRunningTurn", async () => {
  const { host, runner } = buildHost();
  const { app, stdout, factory } = setup(host, ReplOnly);

  const code = await app.runAsync([], nullTextReader, stdout, new StringTextWriter(), TTY, TTY);

  assert.equal(code, 0);
  assert.deepEqual((runner as FakeRunner).messages, []);
  assert.ok(stdout.text().includes("di>"));
});

test("Interactive_WithTuiEligible_LaunchesTui_SkipsRepl", async () => {
  // M4：交互默认交 TS TUI。TTY + 入口可解析 + node 可用 + spawn 返回 0 → 返回 TUI 退出码，
  // Repl 完全不跑（无 "di>" 提示、无回合消费 stdin）。
  let spawnCalls = 0;
  const tui: TuiLauncherContext = {
    getEnv: () => undefined,
    resolveEntry: () => "fake-entry.js",
    nodeAvailable: () => true,
    spawn: () => {
      spawnCalls += 1;
      return 0;
    },
  };
  const { host, runner } = buildHost();
  const { app, stdout, stderr, factory } = setup(host, tui);
  const stdin = new LineTextReader(["你好", "/exit"]);

  const code = await app.runAsync([], stdin, stdout, stderr, TTY, TTY);

  assert.equal(code, 0);
  assert.deepEqual((runner as FakeRunner).messages, []); // Repl 未运行，无回合
  assert.ok(!stdout.text().includes("di>"));
  assert.equal(spawnCalls, 1);
  assert.equal(factory.calls, 1);
});

// ---- tools ----

function writeCases(content: string): string {
  const path = join(tmpdir(), "di-eval-cases-" + randomUUID() + ".json");
  writeFileSync(path, content);
  return path;
}

/** Records host build count; throws when no fake host is provided (that path must not build). */
class HostFactory {
  calls = 0;
  private readonly host: CliHost | null;

  constructor(host: CliHost | null) {
    this.host = host;
  }

  /** Arrow field so `factory.create` stays bound when passed as a bare function reference. */
  create = (_args: CliArgs, _workspace: string, _stderr: TextWriter, _useAnsi: boolean): CliHost => {
    this.calls += 1;
    if (this.host === null) throw new Error("该路径不应构建宿主");
    return this.host;
  };
}
