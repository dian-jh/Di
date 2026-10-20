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
  ModelSelection,
  nullTextReader,
  SessionStore,
  StringTextWriter,
  type CliArgs,
  type CliHost,
  type Skill,
  type TextWriter,
} from "@di/coding-agent";
import { FakeAdapter, FakeModelService, RecordingHost } from "../commands/test-doubles.ts";

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

function setup(host: CliHost | null = null) {
  const stdout = new StringTextWriter();
  const stderr = new StringTextWriter();
  const factory = new HostFactory(host);
  const app = new CliApp(factory.create);
  return { app, stdout, stderr, factory };
}

/** Fake host: a ModelSelection over a fake model service + a skills list. */
function makeHost(models: FakeModelService, skills: readonly Skill[]): CliHost {
  return {
    models: new ModelSelection(models, new RecordingHost()),
    skills,
  };
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

// ---- deferred interactive/print/json/rpc bodies: fail closed with a clear seam ----

test("DeferredMode_Interactive_BuildsHost_ReportsNotYetImplemented", async () => {
  const service = new FakeModelService();
  const { app, stdout, stderr, factory } = setup(makeHost(service, []));

  const code = await app.runAsync(["--mode", "interactive"], new LineTextReader(["你好", "/exit"]), stdout, stderr, TTY, TTY);

  assert.equal(code, 1);
  assert.ok(stderr.text().includes("interactive"));
  assert.ok(stderr.text().includes("P6.3c"));
  assert.equal(factory.calls, 1); // host is built first (the P6.3c body slots in here)
});

test("DeferredMode_Json_BuildsHost_ReportsNotYetImplemented", async () => {
  const service = new FakeModelService();
  const { app, stdout, stderr, factory } = setup(makeHost(service, []));

  const code = await app.runAsync(["--mode", "json", "prompt"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 1);
  assert.ok(stderr.text().includes("json"));
  assert.ok(stderr.text().includes("P6.3c"));
  assert.equal(factory.calls, 1);
});

test("DeferredMode_Print_BuildsHost_ReportsNotYetImplemented", async () => {
  const service = new FakeModelService();
  const { app, stdout, stderr, factory } = setup(makeHost(service, []));

  const code = await app.runAsync(["--mode", "print", "prompt"], nullTextReader, stdout, stderr, TTY, TTY);

  assert.equal(code, 1);
  assert.ok(stderr.text().includes("print"));
  assert.equal(factory.calls, 1);
});

test("DeferredMode_Rpc_BuildsHost_ReportsNotYetImplemented", async () => {
  const service = new FakeModelService();
  const { app, stdout, stderr, factory } = setup(makeHost(service, []));

  const code = await app.runAsync(["--mode", "rpc"], new LineTextReader(['{"type":"request","id":1,"method":"shutdown","params":{}}']), stdout, stderr, TTY, TTY);

  assert.equal(code, 1);
  assert.ok(stderr.text().includes("rpc"));
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
