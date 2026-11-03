const AUTH_RECOVERY_PATTERN =
  /AI CLI agent not configured|agent isn't logged in|authentication is required|unauthor|invalid api key|oauth|ACP connection closed|can't authenticate|Keychain/i;

const KEYCHAIN_PATTERN = /Keychain|can't authenticate|ACP connection closed/i;

const MAX_AGENT_ERROR_CHARS = 200;

export function isAgentAuthRecoveryError(message: string | null | undefined): boolean {
  return AUTH_RECOVERY_PATTERN.test(message ?? "");
}

/**
 * The agent's own error, without the guidance the server appends after it
 * (`withAgentKeychainHint` separates the two with a blank line).
 */
function agentErrorHead(message: string): string {
  const head = message.split(/\n\s*\n/)[0]?.trim() ?? "";
  return head.length > MAX_AGENT_ERROR_CHARS
    ? `${head.slice(0, MAX_AGENT_ERROR_CHARS - 1)}…`
    : head;
}

export function agentAuthRecoveryDescription(message: string): string {
  const hint = KEYCHAIN_PATTERN.test(message)
    ? "Reconnect the agent in Settings. If it is already connected, check Keychain access there."
    : "Reconnect the agent in Settings, then retry.";
  // Keep the raw error visible: the same advice covers several unrelated
  // failures, and without it a report can't tell which one happened.
  const head = agentErrorHead(message);
  return head ? `${hint} Agent error: ${head}` : hint;
}
