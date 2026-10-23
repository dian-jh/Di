import type { AgentSession, SessionTurnOptions } from "../core/agent-session.ts";
import type { Skill } from "../core/skills/skill.ts";
import type { TurnRunner } from "../cli/cli-host.ts";

/*
 * Bridge an {@link AgentSession} to the {@link TurnRunner} seam shared by the
 * CLI modes. The host stores the current model label and resolves it to a
 * `ChatModel` at turn boundaries and model switches. The remaining methods
 * delegate to the session: `runTurn`, `resetHistory`, and `setActiveSkills`.
 */
export function createSessionRunner(
  session: AgentSession,
  label: { currentModel: string; setCurrentModel?: (model: string) => void },
  optionsProvider: (userMessage: string) => Partial<Omit<SessionTurnOptions, "userMessage" | "signal">> = () => ({}),
): TurnRunner {
  if (session == null) throw new TypeError("createSessionRunner: session is required");
  return {
    get currentModel(): string {
      return label.currentModel;
    },
    setCurrentModel(model: string): void {
      label.setCurrentModel?.(model);
      label.currentModel = model;
    },
    resetHistory(): void {
      session.resetHistory();
    },
    setActiveSkills(skills: readonly Skill[]): void {
      session.setActiveSkills(skills.map((s) => ({ name: s.name, instructions: s.instructions })));
    },
    runTurn(userMessage: string, signal?: AbortSignal) {
      return session.runTurn({
        userMessage,
        ...optionsProvider(userMessage),
        ...(signal !== undefined ? { signal } : {}),
      });
    },
  };
}
