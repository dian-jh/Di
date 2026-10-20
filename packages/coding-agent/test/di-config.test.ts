import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ConfigParseError, DEFAULT_CONFIG, DiConfig, defaultReadFile } from "@di/coding-agent";
import type { DiConfigDeps, DiConfigSources } from "@di/coding-agent";

/**
 * Layered config merge (P6.1 card 1). Mirrors `Di.Cli/DiConfig.cs` Load at baseline
 * 09f4e08: default -> user (~/.di/config.json) -> project (<workspace>/.di/config.json)
 * -> environment variables, later layers override earlier ones per key with a deep
 * (nested) merge. Loading never creates or overwrites config files.
 */
const deps: DiConfigDeps = { readFile: defaultReadFile };

function sourcesFor(
  home: string,
  workspace: string,
  env: Readonly<Record<string, string | undefined>> = {},
): DiConfigSources {
  return {
    defaults: DEFAULT_CONFIG,
    userConfigPath: join(home, "config.json"),
    projectConfigPath: join(workspace, ".di", "config.json"),
    env,
  };
}

async function withTempDirs(run: (dirs: { home: string; workspace: string }) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "di-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "di-ws-"));
  try {
    await run({ home, workspace });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

async function writeConfig(root: string, subPath: string, content: string): Promise<void> {
  const file = join(root, subPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

test("defaults are the lowest-priority layer", () => {
  const config = DiConfig.merge(
    { DeepSeek: { DefaultReasoningEffort: "high" } },
    { DeepSeek: { DefaultReasoningEffort: "low" } },
    undefined,
    {},
  );
  assert.equal(config.get("DeepSeek:DefaultReasoningEffort"), "low");
});

test("user config overrides defaults", async () => {
  await withTempDirs(async ({ home, workspace }) => {
    await writeConfig(home, "config.json", '{"DeepSeek":{"DefaultReasoningEffort":"low"}}');
    const config = await DiConfig.load(sourcesFor(home, workspace), deps);
    assert.equal(config.get("DeepSeek:DefaultReasoningEffort"), "low");
  });
});

test("project config overrides user config", async () => {
  await withTempDirs(async ({ home, workspace }) => {
    await writeConfig(home, "config.json", '{"Model":{"DefaultModel":"home-model"}}');
    await writeConfig(workspace, ".di/config.json", '{"Model":{"DefaultModel":"proj-model"}}');
    const config = await DiConfig.load(sourcesFor(home, workspace), deps);
    assert.equal(config.get("Model:DefaultModel"), "proj-model");
  });
});

test("environment overrides file config", async () => {
  await withTempDirs(async ({ home, workspace }) => {
    await writeConfig(home, "config.json", '{"Model":{"DefaultModel":"home-model"}}');
    const config = await DiConfig.load(
      sourcesFor(home, workspace, { Model__DefaultModel: "env-model" }),
      deps,
    );
    assert.equal(config.get("Model:DefaultModel"), "env-model");
  });
});

test("missing configs are harmless and nothing is created", async () => {
  await withTempDirs(async ({ home, workspace }) => {
    const config = await DiConfig.load(sourcesFor(home, workspace), deps);
    assert.equal(config.get("Model:DefaultModel"), undefined);
    assert.equal(config.has("Model:DefaultModel"), false);
    assert.equal(config.get("DeepSeek:DefaultReasoningEffort"), "high"); // defaults still present
    assert.equal(existsSync(join(home, "config.json")), false);
    assert.equal(existsSync(join(workspace, ".di", "config.json")), false);
  });
});

test("existing user config is never overwritten", async () => {
  await withTempDirs(async ({ home, workspace }) => {
    const original = '{"Model":{"DefaultModel":"keep-me"}}';
    await writeConfig(home, "config.json", original);
    await DiConfig.load(sourcesFor(home, workspace), deps);
    const after = await readFile(join(home, "config.json"), "utf8");
    assert.equal(after, original);
  });
});

test("env __ separates sections", async () => {
  await withTempDirs(async ({ home, workspace }) => {
    const config = await DiConfig.load(
      sourcesFor(home, workspace, { Model__DefaultModel: "env-model", Model__Provider: "deepseek" }),
      deps,
    );
    assert.equal(config.get("Model:DefaultModel"), "env-model");
    assert.equal(config.get("Model:Provider"), "deepseek");
  });
});

test("env single underscore is preserved, not a section separator", () => {
  const config = DiConfig.merge({}, undefined, undefined, { Model_DefaultModel: "x" });
  assert.equal(config.get("Model:DefaultModel"), undefined);
  assert.equal(config.get("Model_DefaultModel"), "x");
});

test("lookup and merge are case-insensitive", async () => {
  await withTempDirs(async ({ home, workspace }) => {
    await writeConfig(home, "config.json", '{"model":{"defaultmodel":"home-model"}}');
    await writeConfig(workspace, ".di/config.json", '{"MODEL":{"PROVIDER":"deepseek"}}');
    const config = await DiConfig.load(sourcesFor(home, workspace), deps);
    assert.equal(config.get("Model:DefaultModel"), "home-model");
    assert.equal(config.get("Model:Provider"), "deepseek");
  });
});

test("unknown keys do not break loading and remain addressable", async () => {
  await withTempDirs(async ({ home, workspace }) => {
    await writeConfig(home, "config.json", '{"SomeFutureSection":{"Thing":"x"}}');
    const config = await DiConfig.load(sourcesFor(home, workspace), deps);
    assert.equal(config.get("SomeFutureSection:Thing"), "x");
    assert.equal(config.get("DeepSeek:DefaultReasoningEffort"), "high");
  });
});

test("number, boolean and null values survive the merge", async () => {
  await withTempDirs(async ({ home, workspace }) => {
    await writeConfig(home, "config.json", JSON.stringify({
      AgentLoop: { MaxIterations: 12, HistoryBudgetRatio: 0.4 },
      DeepSeek: { StrictTools: false },
      Model: { DefaultModel: null },
    }));
    const config = await DiConfig.load(sourcesFor(home, workspace), deps);
    assert.equal(config.get("AgentLoop:MaxIterations"), 12);
    assert.equal(config.get("AgentLoop:HistoryBudgetRatio"), 0.4);
    assert.equal(config.get("DeepSeek:StrictTools"), false);
    assert.equal(config.get("Model:DefaultModel"), null);
    assert.equal(config.has("Model:DefaultModel"), true);
    assert.equal(config.has("Model:Missing"), false);
  });
});

test("nested merge is deep, not a shallow spread", () => {
  const config = DiConfig.merge(
    {},
    { Model: { DefaultModel: "home-model", Provider: "home-provider" } },
    { Model: { Provider: "proj-provider" } },
    {},
  );
  assert.equal(config.get("Model:DefaultModel"), "home-model"); // survives the override
  assert.equal(config.get("Model:Provider"), "proj-provider"); // overridden per-key
});

test("JSONC comments and trailing commas in config files are accepted", async () => {
  await withTempDirs(async ({ home, workspace }) => {
    await writeConfig(home, "config.json", `{
  // 用户配置允许注释（与 C# JsonConfigurationProvider 行为一致）
  "Model": { "DefaultModel": "home-model" }, /* trailing block comment */
  "DeepSeek": { "StrictTools": false, },
}`);
    const config = await DiConfig.load(sourcesFor(home, workspace), deps);
    assert.equal(config.get("Model:DefaultModel"), "home-model");
    assert.equal(config.get("DeepSeek:StrictTools"), false);
  });
});

test("malformed config throws ConfigParseError naming the source", async () => {
  await withTempDirs(async ({ home, workspace }) => {
    await writeConfig(home, "config.json", '{"Model": {');
    await assert.rejects(
      DiConfig.load(sourcesFor(home, workspace), deps),
      (error: unknown) => {
        assert.ok(error instanceof ConfigParseError);
        assert.equal(error.source, join(home, "config.json"));
        return true;
      },
    );
  });
});

test("a config file whose root is not an object is rejected", async () => {
  await withTempDirs(async ({ home, workspace }) => {
    await writeConfig(home, "config.json", "[1, 2, 3]");
    await assert.rejects(
      DiConfig.load(sourcesFor(home, workspace), deps),
      (error: unknown) => error instanceof ConfigParseError,
    );
  });
});
