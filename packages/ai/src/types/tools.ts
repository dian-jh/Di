/**
 * Tool schema vocabulary (from Di baseline `Core/Llm/ChatTool.cs`).
 *
 * Only the model-facing schema lives here; executors/validators belong to
 * @di/agent. `parameters` is a JSON Schema object carried as data.
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object payload. */
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
}
