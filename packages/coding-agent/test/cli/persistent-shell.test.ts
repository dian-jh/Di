import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import type { ChatModel, ContentBlock, ModelEvent, ModelRequest, ModelResponse } from "@di/ai";
import {
  DiHome,
  StringTextWriter,
  ShellSession,
  createCliHost,
  createBashTool,
  createPowerShellTool,
  platformSessionShell,
  powershellSessionShell,
  type ModelInfo,
  type ModelService,
  type ProviderInfo,
  type ResolvedModelInfo,
  type Skill,
} from "@di/coding-agent";
import { makeArgs } from "../modes/test-host.ts";

const root = mkdtempSync(join(tmpdir(), "di-persistent-shell-"));
test.after(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

const windows = process.platform === "win32";
const echo = windows ? "echo recovered" : "echo recovered";
const longCommand = windows ? "ping -n 8 127.0.0.1 >nul" : "sleep 8";

test("persistent platform shell timeout kills the session and the next call recreates it", async () => {
  const session = new ShellSession(root, platformSessionShell);
  const tool = createBashTool(root, { session });
  try {
    const timedOut = await tool.execute(JSON.stringify({ command: longCommand, timeout: 1 }));
    assert.equal(timedOut.isError, true);
    assert.ok(timedOut.text.startsWith("error:"), timedOut.text);
    const recovered = await tool.execute(JSON.stringify({ command: echo }));
    assert.equal(recovered.isError, false, recovered.text);
    assert.ok(recovered.text.includes("recovered"), recovered.text);
  } finally {
    session.dispose();
  }
});

test("persistent platform shell cancellation kills the session and permits a new one", async () => {
  const session = new ShellSession(root, platformSessionShell);
  const tool = createBashTool(root, { session });
  const controller = new AbortController();
  try {
    const pending = tool.execute(JSON.stringify({ command: longCommand }), controller.signal);
    const abortTimer = setTimeout(() => controller.abort(), 300);
    try {
      await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
    } finally {
      clearTimeout(abortTimer);
    }
    const recovered = await tool.execute(JSON.stringify({ command: echo }));
    assert.ok(recovered.text.includes("recovered"), recovered.text);
  } finally {
    session.dispose();
  }
});

test("dispose marks a live persistent session dead", async () => {
  const session = new ShellSession(root, platformSessionShell);
  const first = await session.execute(windows ? "echo alive" : "echo alive", 5000);
  assert.equal(first.error, null, first.toObservation());
  assert.equal(session.isAlive, true);
  session.dispose();
  assert.equal(session.isAlive, false);
});

test("PowerShell tool accepts its own persistent session and schema", async (t) => {
  const probe = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { windowsHide: true });
  if (probe.error !== undefined || probe.status !== 0 || !existsSync(process.env.SystemRoot ?? "C:\\Windows")) {
    t.skip("Windows PowerShell is unavailable");
    return;
  }

  const session = new ShellSession(root, powershellSessionShell);
  const tool = createPowerShellTool(root, { session });
  try {
    const properties = tool.spec.parameters.properties as Record<string, unknown>;
    assert.equal(properties.working_dir, undefined);
    const first = await tool.execute(JSON.stringify({ command: "$env:DI_PERSISTENT_TEST = 'alive'" }));
    assert.equal(first.isError, false, first.text);
    const second = await tool.execute(JSON.stringify({ command: "Write-Output $env:DI_PERSISTENT_TEST" }));
    assert.ok(second.text.includes("alive"), second.text);
  } finally {
    session.dispose();
  }
});

class ToolRoundModel implements ChatModel {
  readonly requests: ModelRequest[] = [];
  private call = 0;

  stream(request: ModelRequest, _signal?: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const calls = this.call++ === 0
      ? [
          { id: "cmd-set", name: windows ? "cmd" : "bash", arguments: JSON.stringify({ command: windows ? "set DI_SEPARATE=cmd-only" : "export DI_SEPARATE=cmd-only" }) },
          { id: "cmd-read", name: windows ? "cmd" : "bash", arguments: JSON.stringify({ command: windows ? "echo %DI_SEPARATE%" : "echo $DI_SEPARATE" }) },
          { id: "ps-set", name: "powershell", arguments: JSON.stringify({ command: "$env:DI_SEPARATE = 'powershell-only'" }) },
          { id: "ps-read", name: "powershell", arguments: JSON.stringify({ command: "Write-Output $env:DI_SEPARATE" }) },
          { id: "cmd-read-after", name: windows ? "cmd" : "bash", arguments: JSON.stringify({ command: windows ? "echo %DI_SEPARATE%" : "echo $DI_SEPARATE" }) },
          { id: "cmd-pid", name: "cmd", arguments: JSON.stringify({ command: `"${process.execPath}" -p "process.ppid"` }) },
          { id: "ps-pid", name: "powershell", arguments: JSON.stringify({ command: "Write-Output $PID" }) },
        ]
      : [];
    const content: ContentBlock[] = calls.length > 0
      ? calls.map((call) => ({ type: "tool-call", ...call }))
      : [{ type: "text", text: "done" }];
    const response: ModelResponse = {
      message: { role: "assistant", content },
      finishReason: calls.length > 0 ? { type: "tool-calls" } : { type: "stop" },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "fake",
      timestamp: Date.now(),
    };
    return (async function* (): AsyncGenerator<ModelEvent> {
      yield { type: "completed", response };
    })();
  }
}

class NoNetworkCatalog implements ModelService {
  listProviders(): readonly ProviderInfo[] { return [{ id: "deepseek", name: "DeepSeek" }]; }
  listModels(): readonly ModelInfo[] { return [{ provider: "deepseek", id: "deepseek-flash", name: "Fake" }]; }
  async refreshModels(): Promise<readonly ModelInfo[]> { return this.listModels(); }
  async checkAuth(): Promise<boolean> { return true; }
  async resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> { return { provider, id, name: id }; }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test("real host keeps PowerShell independent from cmd and dispose exits both shell processes", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows cmd and PowerShell lifecycle acceptance");
    return;
  }

  const diHome = mkdtempSync(join(root, "host-di-"));
  const workspace = mkdtempSync(join(root, "host-ws-"));
  const model = new ToolRoundModel();
  const host = await createCliHost(makeArgs({}), workspace, new StringTextWriter(), false, {
    diHome: DiHome.fromDirectory(diHome),
    modelFactory: () => model,
    modelService: new NoNetworkCatalog(),
    skills: [] as readonly Skill[],
  });
  try {
    await host.runner.runTurn("exercise both shells");
    const results = model.requests[1]!.messages.filter((message) => message.role === "tool");
    const resultFor = (id: string) => results.find((message) => message.toolCallId === id)?.content ?? "";
    for (const id of ["cmd-set", "cmd-read", "ps-set", "ps-read", "cmd-read-after"]) {
      assert.ok(resultFor(id).includes("exit: 0"), `${id}: ${resultFor(id)}`);
    }
    assert.ok(resultFor("cmd-read").includes("cmd-only"), resultFor("cmd-read"));
    assert.ok(resultFor("ps-read").includes("powershell-only"), resultFor("ps-read"));
    assert.ok(resultFor("cmd-read-after").includes("cmd-only"), resultFor("cmd-read-after"));
    const shellPids = ["cmd-pid", "ps-pid"].map((id) => {
      const result = resultFor(id);
      const match = /^exit: 0\s+(\d+)\s*$/.exec(result);
      assert.ok(match, `${id} must return its shell PID: ${result}`);
      const pid = Number(match[1]);
      assert.ok(pid > 0 && isProcessAlive(pid), `${id} must be alive before dispose`);
      return pid;
    });
    assert.notEqual(shellPids[0], shellPids[1], "cmd and PowerShell must have independent processes");

    host.dispose?.();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (shellPids.every((pid) => !isProcessAlive(pid))) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.fail(`host.dispose left shell processes running: ${shellPids}`);
  } finally {
    host.dispose?.();
  }
});
