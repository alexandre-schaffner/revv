// ── Agent keychain access guidance (Solution B: guide, don't store) ──────────
//
// Some ACP agents store their login in the macOS login Keychain (Claude Code
// today; declared per-agent via `keychainAuth` in the shared ACP registry).
// Revv's server runs as a background LaunchAgent, and whether that background
// context is permitted to read the item is governed by the item's Access
// Control — a per-machine state. When blocked, the spawned agent subprocess
// can't authenticate and exits: a 401 / "ACP connection closed".
//
// This module stores/injects NO credential. It (a) detects the block and (b)
// tells the user how to grant access. Everything agent-specific (which service,
// which remediation) comes from the registry, so covering another keychain-using
// provider is one registry entry — no change here.
//
// Settings' "Test agent" button (`agent-check.ts`) runs a real one-line turn
// rather than probing the Keychain or `claude auth status`: neither proves the
// agent subprocess itself can authenticate, and only a real turn does.
//
// An auth-shaped failure has TWO real causes that look identical from the raw
// ACP error alone (401 / "connection closed"): the agent simply isn't logged
// in yet, or (rarer) it IS logged in but the background service is Keychain-ACL
// -blocked from reading it. `detectAgentAuth` — now context-aware for
// claude-code, resolved against the same `CLAUDE_CONFIG_DIR` the failing spawn
// used (see `claude-config.ts`) — tells us which bucket we're in. Not-logged-in
// leads (the common case); the keychain remediation is either the SOLE message
// (agent is logged in, so ACL is the credible diagnosis) or a secondary
// "already signed in?" hint (agent reports not logged in, so ACL is only a
// fallback guess — the status check itself could be what's ACL-blocked).

import { type AcpAgentId, getAcpAgent, getAgentKeychainAuth } from "@revv/shared";
import { detectAgentAuth } from "../providers/cli-agent";

/**
 * Whether a raw ACP error looks like an auth/keychain block (401, unauthorized,
 * expired token, or the subprocess exiting → "connection closed").
 */
export function looksLikeAuthFailure(message: string): boolean {
  return /401|unauthor|authenticat|invalid api key|oauth|connection closed/i.test(message);
}

/** Plain "go sign in" message, generic across every registry agent. */
function notLoggedInMessage(agent: AcpAgentId): string {
  const label = getAcpAgent(agent).label;
  return (
    `The ${label} agent isn't logged in for this session. Open Revv Settings → ` +
    `AI agent and sign in to ${label}, then retry.`
  );
}

/**
 * The guidance to show after an auth-shaped agent failure, or `null` when the
 * error doesn't look auth-related (so unrelated failures aren't drowned in
 * advice).
 *
 * `isLoggedIn` is checked first to pick the right lead: if the agent isn't
 * authenticated in the active context, that's the credible diagnosis (login
 * is the fix, not a Keychain ACL) — the keychain remediation, when the agent
 * is keychain-backed, is appended only as an "already signed in?" fallback,
 * since the two causes aren't reliably distinguishable from here. If the
 * agent DOES report authenticated, a lingering auth-shaped failure is the
 * keychain remediation's actual target case, so it's shown alone.
 *
 * @param isLoggedIn Test seam for the auth check — defaults to
 * `detectAgentAuth` (context-aware for claude-code, see `claude-config.ts`).
 * Production leaves it at the default.
 */
export function agentFailureGuidance(
  agent: AcpAgentId,
  rawMessage: string,
  isLoggedIn: (agent: AcpAgentId) => boolean = detectAgentAuth,
): string | null {
  if (!looksLikeAuthFailure(rawMessage)) return null;

  const keychainAuth = getAgentKeychainAuth(agent);

  if (!isLoggedIn(agent)) {
    const fallbackHint = keychainAuth ? `\n\nAlready signed in? ${keychainAuth.remediation}` : "";
    return `${notLoggedInMessage(agent)}${fallbackHint}`;
  }

  return keychainAuth?.remediation ?? null;
}

/** Append {@link agentFailureGuidance} to an agent error, after a blank line. */
export function withAgentKeychainHint(
  agent: AcpAgentId,
  rawMessage: string,
  isLoggedIn: (agent: AcpAgentId) => boolean = detectAgentAuth,
): string {
  const guidance = agentFailureGuidance(agent, rawMessage, isLoggedIn);
  return guidance ? `${rawMessage}\n\n${guidance}` : rawMessage;
}
