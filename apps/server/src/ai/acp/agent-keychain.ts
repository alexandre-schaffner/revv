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
// `probeAgentKeychainReadable` (Settings' manual "Check access" button) no
// longer probes the Keychain item directly — a raw, unscoped service-name
// probe can't see an isolated `CLAUDE_CONFIG_DIR`'s own scoped item (see
// `claude-config.ts`), so it delegates to the same context-aware auth probe
// the agent spawn itself uses and reports that verdict.
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
    `AI Configuration and sign in to ${label}, then retry.`
  );
}

/**
 * Append a diagnosis to an auth failure. No-op for errors that don't look
 * auth-related, so unrelated failures aren't drowned in advice.
 *
 * `isLoggedIn` is checked first to pick the right lead: if the agent isn't
 * authenticated in the active context, that's the credible diagnosis (login
 * is the fix, not a Keychain ACL) — the keychain remediation, when the agent
 * is keychain-backed, is appended only as an "already signed in?" fallback,
 * since the two causes aren't reliably distinguishable from here. If the
 * agent DOES report authenticated, a lingering auth-shaped failure is the
 * keychain remediation's actual target case, so it's shown alone as before.
 *
 * @param isLoggedIn Test seam for the auth check — defaults to
 * `detectAgentAuth` (context-aware for claude-code, see `claude-config.ts`).
 * Production leaves it at the default.
 */
export function withAgentKeychainHint(
  agent: AcpAgentId,
  rawMessage: string,
  isLoggedIn: (agent: AcpAgentId) => boolean = detectAgentAuth,
): string {
  if (!looksLikeAuthFailure(rawMessage)) return rawMessage;

  const keychainAuth = getAgentKeychainAuth(agent);

  if (!isLoggedIn(agent)) {
    const fallbackHint = keychainAuth ? `\n\nAlready signed in? ${keychainAuth.remediation}` : "";
    return `${rawMessage}\n\n${notLoggedInMessage(agent)}${fallbackHint}`;
  }

  if (!keychainAuth) return rawMessage;
  return `${rawMessage}\n\n${keychainAuth.remediation}`;
}

/** The agent's keychain remediation text, or `null` if it isn't keychain-backed. */
export function agentKeychainRemediation(agent: AcpAgentId): string | null {
  return getAgentKeychainAuth(agent)?.remediation ?? null;
}

/**
 * Whether the agent can actually authenticate in the ACTIVE context — the
 * source of truth for Settings' manual "Check access" button.
 *
 * This used to run a raw `security find-generic-password -w -s <fixed service
 * name>` readability probe. That check was already only a heuristic (a
 * readable item can be stale — logout doesn't always clear it), but it became
 * outright WRONG once claude-code sessions could isolate into a resolved
 * `CLAUDE_CONFIG_DIR` (see `claude-config.ts`): macOS Keychain storage is
 * scoped PER CONFIG DIR, under an unpublished per-dir service name suffix, so
 * the fixed `<service>` name probe always missed an isolated login and
 * reported `false` regardless of whether the user was actually signed in.
 *
 * There is also no reliable way to distinguish "not logged in" from
 * "logged in but Keychain-ACL-blocked" from any available signal — a blocked
 * read and a logged-out session both surface as "not logged in" from the
 * agent's own status command (documented in the runbook). So rather than keep
 * that false precision, this now delegates to `detectAgentAuth` — the SAME
 * context-aware probe (`claudeStatusCommandEnv` → `resolveClaudeConfigDir`)
 * the agent spawn and the walkthrough-failure diagnosis already rely on — and
 * reports its verdict directly: `true` (authenticated), `false` (not — could
 * be either cause above; the returned remediation text still covers both),
 * or `null` (the agent isn't keychain-backed, so this check doesn't apply).
 *
 * @param isLoggedIn Test seam for the auth check — same contract as
 * {@link withAgentKeychainHint}'s, defaults to `detectAgentAuth`.
 */
export async function probeAgentKeychainReadable(
  agent: AcpAgentId,
  isLoggedIn: (agent: AcpAgentId) => boolean = detectAgentAuth,
): Promise<boolean | null> {
  if (!getAgentKeychainAuth(agent)) return null;
  return isLoggedIn(agent);
}
