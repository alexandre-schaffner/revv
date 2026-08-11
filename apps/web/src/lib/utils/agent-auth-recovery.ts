const AUTH_RECOVERY_PATTERN =
  /AI CLI agent not configured|agent isn't logged in|authentication is required|unauthor|invalid api key|oauth|ACP connection closed|can't authenticate|Keychain/i;

const KEYCHAIN_PATTERN = /Keychain|can't authenticate|ACP connection closed/i;

export function isAgentAuthRecoveryError(message: string | null | undefined): boolean {
  return AUTH_RECOVERY_PATTERN.test(message ?? "");
}

export function agentAuthRecoveryDescription(message: string): string {
  if (KEYCHAIN_PATTERN.test(message)) {
    return "Reconnect the agent in Settings. If it is already connected, check Keychain access there.";
  }
  return "Reconnect the agent in Settings, then retry.";
}
