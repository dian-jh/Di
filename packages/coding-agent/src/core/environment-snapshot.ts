/**
 * Minimal environment snapshot (Di baseline `Core/AgentLoop/EnvironmentSnapshot.cs`):
 * only the working directory + a self-serve hint. No git process is spawned and no
 * repo state (branch / changes / commits) is injected — the model fetches those via
 * bash when it actually needs them ("minimal injection + self-serve").
 *
 * The text is constant for a given working directory, so the session appends it to
 * the persistent history exactly once (on change) and it then stays in the stable
 * byte prefix across turns/iterations, continuously hitting the provider cache.
 */
export function buildEnvironmentSnapshot(workingDirectory: string): string {
  return (
    "## 环境\n" +
    `- 工作目录: ${workingDirectory}\n` +
    "- 分支 / 未提交改动 / 最近提交需要时用 bash 自助查询：git status --short -b、git log --oneline -5"
  );
}
