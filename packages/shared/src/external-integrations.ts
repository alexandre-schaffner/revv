// Coding agents running outside Revv's own agent lifecycle can read the active
// PR's walkthrough, issues, and review threads. Each provider gets an
// account-scoped credential and a small stdio MCP bridge; the server derives
// the PR from the agent's checkout.

export const EXTERNAL_AGENT_PROVIDERS = ["claude-code", "codex", "opencode", "cursor"] as const;

export type ExternalAgentProvider = (typeof EXTERNAL_AGENT_PROVIDERS)[number];

export interface ExternalIntegrationStatus {
  readonly provider: ExternalAgentProvider;
  readonly connected: boolean;
  /** The account-scoped client entry still exists on disk. */
  readonly clientConfigured: boolean;
  readonly clientName: string;
  /** What the user still has to do in the agent itself after connecting. */
  readonly activation: string;
  readonly createdAt: string | null;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
}

export interface ExternalIntegrationConnectResult extends ExternalIntegrationStatus {
  /** Files and directories the connect just wrote, surfaced in the UI. */
  readonly locations: readonly string[];
}

export const EXTERNAL_AGENT_PROVIDER_NAMES: Readonly<Record<ExternalAgentProvider, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
};

/**
 * What an external agent's tools may do. Every tool declares the one it needs,
 * and every credential holds them all: a new scope reaches existing installs
 * with the tool that needs it, with no backfill.
 */
export const EXTERNAL_AGENT_SCOPES = [
  "context:read",
  "walkthrough:edit",
  "walkthrough:generate",
  "issues:resolve",
  "comments:write",
] as const;

export type ExternalAgentScope = (typeof EXTERNAL_AGENT_SCOPES)[number];

/** A full commit SHA, as a checkout reports its heads. */
export const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function isExternalAgentProvider(value: string): value is ExternalAgentProvider {
  return (EXTERNAL_AGENT_PROVIDERS as readonly string[]).includes(value);
}
