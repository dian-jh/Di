import type { AgentSession } from "../core/agent-session.ts";
import type { Skill } from "../core/skills/skill.ts";
import type { TurnRunner } from "../cli/cli-host.ts";

/**
 * Bridge an {@link AgentSession} to the {@link TurnRunner} seam the modes drive
 * (C# `CliHost.Create` builds the AgentRunner once and hands its `IAgentRunner`
 * surface to every mode). The current-model LABEL is a separate holder (the
 * composition root owns it and resolves the label to the session's `ChatModel`
 * at turn boundaries / switches — P7 wiring); the rest maps one-to-one:
 * `runTurn` → `session.runTurn`, `resetHistory` → `session.resetHistory`,
 * `setActiveSkills` → the session's volatile skill tail (name + instructions).
 */
export function createSessionRunner(
  session: AgentSession,
  label: { currentModel: string; setCurrentModel?: (model: string) => void },
): TurnRunner {
  if (session == null) throw new TypeError("createSessionRunner: session is required");
  return {
    get currentModel(): string {
      return label.currentModel;
    },
    setCurrentModel(model: string): void {
      label.currentModel = model;
      label.setCurrentModel?.(model);
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
        ...(signal !== undefined ? { signal } : {}),
      });
    },
  };
}
