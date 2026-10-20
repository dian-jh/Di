import { join } from "node:path";

export interface DiHomeEnvironment {
  readonly DI_HOME?: string | undefined;
}

export class DiHome {
  static readonly envVariableName = "DI_HOME";

  readonly rootDirectory: string;

  private constructor(rootDirectory: string) {
    if (typeof rootDirectory !== "string") {
      throw new TypeError("rootDirectory must be a string");
    }
    this.rootDirectory = rootDirectory;
  }

  /**
   * Resolve the default home: DI_HOME env wins, otherwise <userHome>/.di.
   * A blank/whitespace-only DI_HOME falls back to the default (mirrors .NET
   * `string.IsNullOrWhiteSpace`). A non-blank value is used verbatim — relative
   * values stay relative, no absolute normalization (mirrors `Path.Combine`).
   */
  static fromEnvironment(env: Readonly<DiHomeEnvironment>, userHome: string): DiHome {
    const value = env.DI_HOME;
    const root = value !== undefined && value.trim().length > 0 ? value : join(userHome, ".di");
    return new DiHome(root);
  }

  static fromDirectory(rootDirectory: string): DiHome {
    return new DiHome(rootDirectory);
  }

  get configFile(): string {
    return join(this.rootDirectory, "config.json");
  }

  get sessionsDirectory(): string {
    return join(this.rootDirectory, "sessions");
  }

  get logsDirectory(): string {
    return join(this.rootDirectory, "logs");
  }

  get skillsDirectory(): string {
    return join(this.rootDirectory, "skills");
  }

  get commandsDirectory(): string {
    return join(this.rootDirectory, "commands");
  }

  get agentsDirectory(): string {
    return join(this.rootDirectory, "agents");
  }

  get mcpConfigFile(): string {
    return join(this.rootDirectory, "mcp.json");
  }

  static projectDirectory(workspace: string): string {
    return join(workspace, ".di");
  }

  static projectConfigFile(workspace: string): string {
    return join(workspace, ".di", "config.json");
  }
}
