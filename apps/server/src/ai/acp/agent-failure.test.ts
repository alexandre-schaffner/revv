import { describe, expect, it } from "bun:test";
import { getAgentKeychainAuth } from "@revv/shared";
import { agentFailureGuidance, looksLikeAuthFailure } from "./agent-failure";

// The remediation assertions below are only meaningful while the registry
// declares Claude Code's Keychain-backed login.
const claudeKeychain = getAgentKeychainAuth("claude-code");
if (!claudeKeychain) throw new Error("claude-code must declare its keychainAuth");
const REMEDIATION = claudeKeychain.remediation;

describe("looksLikeAuthFailure", () => {
  it("matches auth / connection-closed errors", () => {
    for (const m of [
      "ACP connection closed",
      "HTTP 401 Unauthorized",
      "Invalid API key",
      "OAuth token expired",
      "failed to authenticate",
    ]) {
      expect(looksLikeAuthFailure(m)).toBe(true);
    }
  });

  it("ignores unrelated errors", () => {
    for (const m of ["ENOENT: spawn failed", "rate limited", "some tool error"]) {
      expect(looksLikeAuthFailure(m)).toBe(false);
    }
  });
});

describe("agentFailureGuidance by login state", () => {
  // Every case pins the `isLoggedIn` seam (3rd arg) so the assertions never
  // depend on this machine's real Claude Code / Codex / Cursor login state.

  it("leads with the keychain remediation ALONE when the agent reports logged in", () => {
    const out = agentFailureGuidance("claude-code", "ACP connection closed", () => true);
    expect(out).toBe(REMEDIATION);
  });

  it("leads with 'not logged in' when the agent reports logged out, with the keychain hint as a secondary fallback", () => {
    const out = agentFailureGuidance("claude-code", "ACP connection closed", () => false);
    expect(out).toContain("Claude Code agent isn't logged in for this session");
    expect(out).toContain("sign in to Claude Code");
    expect(out).toContain("Already signed in?");
    expect(out).toContain(REMEDIATION);
  });

  it("shows the not-logged-in message with NO keychain text for a non-keychain-backed agent", () => {
    const out = agentFailureGuidance("codex", "401 unauthorized", () => false);
    expect(out).toContain("Codex agent isn't logged in for this session");
    expect(out).not.toContain("Keychain");
  });

  it("has nothing to add for an authenticated non-keychain-backed agent", () => {
    expect(agentFailureGuidance("opencode", "ACP connection closed", () => true)).toBeNull();
    expect(agentFailureGuidance("codex", "401 unauthorized", () => true)).toBeNull();
  });

  it("has nothing to add for non-auth errors regardless of login state", () => {
    expect(agentFailureGuidance("claude-code", "ENOENT: spawn failed", () => false)).toBeNull();
  });
});

describe("agentFailureGuidance", () => {
  it("returns only the guidance, without the raw error", () => {
    const guidance = agentFailureGuidance("claude-code", "Authentication required", () => true);
    expect(guidance).toBe(REMEDIATION);
  });

  it("returns null for errors that aren't auth-shaped", () => {
    expect(
      agentFailureGuidance("claude-code", "You've hit your spend limit", () => true),
    ).toBeNull();
  });
});
