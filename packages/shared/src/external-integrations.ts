// ── External coding-agent integrations ──────────────────────────────────────
//
// Revv can expose the active PR's walkthrough, issues, and review threads to
// coding agents running outside Revv's own agent lifecycle (Claude Code,
// Codex, OpenCode, Cursor). Each provider gets an account-scoped credential
// and a small stdio MCP bridge; the server derives the PR from the agent's
// checkout. This module is the source of truth for provider identity.

export const EXTERNAL_AGENT_PROVIDERS = ["claude-code", "codex", "opencode", "cursor"] as const;

export type ExternalAgentProvider = (typeof EXTERNAL_AGENT_PROVIDERS)[number];

export interface ExternalIntegrationStatus {
  readonly provider: ExternalAgentProvider;
  readonly connected: boolean;
  /** The account-scoped client entry still exists on disk. */
  readonly clientConfigured: boolean;
  readonly clientName: string;
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

export function isExternalAgentProvider(value: string): value is ExternalAgentProvider {
  return (EXTERNAL_AGENT_PROVIDERS as readonly string[]).includes(value);
}
