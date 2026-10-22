import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000;

export function runCiUnitTests({
  command = "npm",
  args = ["run", "test", "--workspaces", "--if-present"],
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const windows = process.platform === "win32";
  const npmCommand = command === "npm";
  const executable = windows && npmCommand ? (process.env.ComSpec ?? "cmd.exe") : command;
  const childArgs = windows && npmCommand ? ["/d", "/s", "/c", "npm run test --workspaces --if-present"] : args;
  const child = spawn(executable, childArgs, { stdio: "inherit", detached: !windows, windowsHide: windows });

  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(`Unit tests exceeded the ${Math.ceil(timeoutMs / 1000)} second deadline.\n`);
      if (windows) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => {});
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      process.stderr.write(`${error.message}\n`);
      resolve(1);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(timedOut ? 1 : (code ?? 1));
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runCiUnitTests();
}
