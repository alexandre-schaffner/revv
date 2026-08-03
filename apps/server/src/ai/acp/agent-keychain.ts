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

import { execFile } from "node:child_process";
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
 * Best-effort probe of whether THIS process (the server's own context) can read
 * the agent's keychain item — the same context the agent subprocess inherits, so
 * it's a meaningful signal here (unlike a probe from an interactive shell).
 *
 * Returns `true` (readable), `false` (blocked / prompted / not found), or `null`
 * (the agent isn't keychain-backed). A short timeout guards against a
 * confirmation dialog hanging the call — if it can't complete quickly, we treat
 * it as blocked. Heuristic: the agent's own read path may differ, so `false`
 * means "likely blocked", not proof. `-w` only exercises the Access-Control gate;
 * the secret is never read from stdout, logged, or stored.
 */
export function probeAgentKeychainReadable(agent: AcpAgentId): Promise<boolean | null> {
  const keychainAuth = getAgentKeychainAuth(agent);
  if (!keychainAuth) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const child = execFile(
      "security",
      ["find-generic-password", "-w", "-s", keychainAuth.service],
      { timeout: 4000 },
      (err) => done(!err),
    );
    child.on("error", () => done(false));
  });
}
