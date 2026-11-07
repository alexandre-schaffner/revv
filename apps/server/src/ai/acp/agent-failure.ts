// Every agent turn failure leaves the runner as an `AgentTurnFailure` whose
// `kind` says whether it is an auth problem, so callers (and the web) branch
// on the kind instead of re-reading the message.
//
// Some ACP agents store their login in the macOS login Keychain (Claude Code
// today; declared per-agent via `keychainAuth` in the shared ACP registry).
// Revv's server runs as a background process the desktop app spawns, and
// whether that background context is permitted to read the item is governed
// by the item's Access Control — a per-machine state. When blocked, the spawned agent subprocess
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

import { RequestError } from "@agentclientprotocol/sdk";
import { type AcpAgentId, getAcpAgent, getAgentKeychainAuth } from "@revv/shared";
import type { AgentFailureKind } from "../../domain/errors";
import { detectAgentAuth } from "./agents";

/** ACP's `auth_required` error code (`RequestError.authRequired`). */
const ACP_AUTH_REQUIRED = -32000;

/**
 * Whether a raw agent error looks like an auth/keychain block (401,
 * unauthorized, expired token, or the subprocess exiting → "connection
 * closed"). Agents mostly report auth failures as free text, so this is the
 * fallback behind ACP's structured `auth_required`.
 */
export function looksLikeAuthFailure(message: string): boolean {
  return /401|unauthor|authenticat|invalid api key|oauth|connection closed/i.test(message);
}

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
 * An auth-shaped failure (401 / "connection closed") has two causes the raw
 * error can't tell apart: the agent isn't logged in (common), or it is but the
 * background service is Keychain-ACL-blocked from reading the login. When the
 * agent reports not logged in, sign-in leads and the keychain remediation is
 * only an "already signed in?" fallback, since the status check itself could
 * be what's ACL-blocked. When it reports logged in, the ACL is the credible
 * diagnosis and its remediation is shown alone.
 *
 * @param isLoggedIn Test seam; production leaves it at `detectAgentAuth`,
 * which probes in the same `CLAUDE_CONFIG_DIR` the failing spawn used.
 */
export async function agentFailureGuidance(
  agent: AcpAgentId,
  rawMessage: string,
  isLoggedIn: (agent: AcpAgentId) => Promise<boolean> = detectAgentAuth,
): Promise<string | null> {
  if (!looksLikeAuthFailure(rawMessage)) return null;

  const keychainAuth = getAgentKeychainAuth(agent);

  if (!(await isLoggedIn(agent))) {
    const fallbackHint = keychainAuth ? `\n\nAlready signed in? ${keychainAuth.remediation}` : "";
    return `${notLoggedInMessage(agent)}${fallbackHint}`;
  }

  return keychainAuth?.remediation ?? null;
}

/**
 * A failed agent turn. `message` is the agent's error with any guidance after
 * a blank line; `agentMessage` and `guidance` keep the two apart.
 */
export interface AgentTurnFailure {
  readonly kind: AgentFailureKind;
  readonly message: string;
  readonly agentMessage: string;
  readonly guidance: string | null;
  readonly cause: unknown;
}

export async function agentTurnFailure(agent: AcpAgentId, err: unknown): Promise<AgentTurnFailure> {
  const raw = err instanceof Error ? err.message : String(err);
  const auth =
    (err instanceof RequestError && err.code === ACP_AUTH_REQUIRED) || looksLikeAuthFailure(raw);
  const guidance = await agentFailureGuidance(agent, raw);
  return {
    kind: auth ? "auth" : "other",
    message: guidance ? `${raw}\n\n${guidance}` : raw,
    agentMessage: raw,
    guidance,
    cause: err,
  };
}
