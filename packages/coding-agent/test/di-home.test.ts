import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { DiHome } from "@di/coding-agent";

/**
 *
 * <userHome>/.di, non-blank values are used verbatim (no absolute normalization).
 */
test("DI_HOME blank (undefined/empty/whitespace) falls back to <userHome>/.di", () => {
  const userHome = join("C:", "Users", "tester");
  for (const value of [undefined, "", "   ", "\t"]) {
    const home = DiHome.fromEnvironment({ DI_HOME: value }, userHome);
    assert.equal(home.rootDirectory, join(userHome, ".di"), `DI_HOME=${JSON.stringify(value)}`);
  }
});

test("DI_HOME absolute root is used verbatim", () => {
  const root = join("D:", "custom", "di");
  const home = DiHome.fromEnvironment({ DI_HOME: root }, join("C:", "Users", "tester"));
  assert.equal(home.rootDirectory, root);
});

test("DI_HOME relative root is preserved", () => {
  const home = DiHome.fromEnvironment({ DI_HOME: "relative-root" }, join("C:", "Users", "tester"));
  assert.equal(home.rootDirectory, "relative-root");
});

test("fromDirectory pins an explicit root (host/test injection)", () => {
  const root = join("E:", "tmp", "home");
  const home = DiHome.fromDirectory(root);
  assert.equal(home.rootDirectory, root);
});

test("derives the documented user-level paths under the root", () => {
  const root = join("C:", "di");
  const home = DiHome.fromDirectory(root);
  assert.equal(home.configFile, join(root, "config.json"));
  assert.equal(home.sessionsDirectory, join(root, "sessions"));
  assert.equal(home.logsDirectory, join(root, "logs"));
  assert.equal(home.skillsDirectory, join(root, "skills"));
  assert.equal(home.commandsDirectory, join(root, "commands"));
  assert.equal(home.agentsDirectory, join(root, "agents"));
  assert.equal(home.mcpConfigFile, join(root, "mcp.json"));
});

test("project config derives <workspace>/.di/config.json", () => {
  const workspace = join("C:", "ws");
  assert.equal(DiHome.projectDirectory(workspace), join(workspace, ".di"));
  assert.equal(DiHome.projectConfigFile(workspace), join(workspace, ".di", "config.json"));
});

test("env variable name matches the documented DI_HOME", () => {
  assert.equal(DiHome.envVariableName, "DI_HOME");
});
