export class AgentUnavailableError extends Error {
  readonly code = "AGENT_UNAVAILABLE";
  constructor(
    public readonly agentName: string,
    message?: string,
  ) {
    super(
      message ??
        `opencode daemon has no agent named '${agentName}'. Install or configure one in .opencode/opencode.toml.`,
    );
    this.name = "AgentUnavailableError";
  }
}
