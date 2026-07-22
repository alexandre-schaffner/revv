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

import { execFile } from "node:child_process";
import { platform } from "node:os";
import { type AcpAgentId, getAgentKeychainAuth } from "@revv/shared";

/**
 * Whether a raw ACP error looks like an auth/keychain block (401, unauthorized,
 * expired token, or the subprocess exiting → "connection closed").
 */
export function looksLikeAuthFailure(message: string): boolean {
  return /401|unauthor|authenticat|invalid api key|oauth|connection closed/i.test(message);
}

/**
 * Append the agent's keychain remediation to an auth failure on macOS. No-op for
 * agents that aren't keychain-backed (per the registry), non-macOS, or errors
 * that don't look auth-related — so unrelated failures aren't drowned in advice.
 */
export function withAgentKeychainHint(agent: AcpAgentId, rawMessage: string): string {
  if (platform() !== "darwin") return rawMessage;
  const keychainAuth = getAgentKeychainAuth(agent);
  if (!keychainAuth) return rawMessage;
  if (!looksLikeAuthFailure(rawMessage)) return rawMessage;
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
 * (not macOS, or the agent isn't keychain-backed). A short timeout guards against
 * a confirmation dialog hanging the call — if it can't complete quickly, we treat
 * it as blocked. Heuristic: the agent's own read path may differ, so `false`
 * means "likely blocked", not proof. `-w` only exercises the Access-Control gate;
 * the secret is never read from stdout, logged, or stored.
 */
export function probeAgentKeychainReadable(agent: AcpAgentId): Promise<boolean | null> {
  if (platform() !== "darwin") return Promise.resolve(null);
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
