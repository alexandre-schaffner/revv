import { describe, expect, it } from "bun:test";
import { getAgentKeychainAuth } from "@revv/shared";
import { agentFailureGuidance, looksLikeAuthFailure } from "./agent-failure";

// The remediation assertions below are only meaningful while the registry
// declares Claude Code's Keychain-backed login.
const claudeKeychain = getAgentKeychainAuth("claude-code");
if (!claudeKeychain) throw new Error("claude-code must declare its keychainAuth");
const REMEDIATION = claudeKeychain.remediation;

describe("looksLikeAuthFailure", () => {
  it("matches auth / connection-closed errors", async () => {
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

  it("ignores unrelated errors", async () => {
    for (const m of ["ENOENT: spawn failed", "rate limited", "some tool error"]) {
      expect(looksLikeAuthFailure(m)).toBe(false);
    }
  });
});

describe("agentFailureGuidance by login state", () => {
  // Every case pins the `isLoggedIn` seam (3rd arg) so the assertions never
  // depend on this machine's real Claude Code / Codex / Cursor login state.

  it("leads with the keychain remediation ALONE when the agent reports logged in", async () => {
    const out = await agentFailureGuidance(
      "claude-code",
      "ACP connection closed",
      async () => true,
    );
    expect(out).toBe(REMEDIATION);
  });

  it("leads with 'not logged in' when the agent reports logged out, with the keychain hint as a secondary fallback", async () => {
    const out = await agentFailureGuidance(
      "claude-code",
      "ACP connection closed",
      async () => false,
    );
    expect(out).toContain("Claude Code agent isn't logged in for this session");
    expect(out).toContain("sign in to Claude Code");
    expect(out).toContain("Already signed in?");
    expect(out).toContain(REMEDIATION);
  });

  it("shows the not-logged-in message with NO keychain text for a non-keychain-backed agent", async () => {
    const out = await agentFailureGuidance("codex", "401 unauthorized", async () => false);
    expect(out).toContain("Codex agent isn't logged in for this session");
    expect(out).not.toContain("Keychain");
  });

  it("has nothing to add for an authenticated non-keychain-backed agent", async () => {
    expect(
      await agentFailureGuidance("opencode", "ACP connection closed", async () => true),
    ).toBeNull();
    expect(await agentFailureGuidance("codex", "401 unauthorized", async () => true)).toBeNull();
  });

  it("has nothing to add for non-auth errors regardless of login state", async () => {
    expect(
      await agentFailureGuidance("claude-code", "ENOENT: spawn failed", async () => false),
    ).toBeNull();
  });
});

describe("agentFailureGuidance", () => {
  it("returns only the guidance, without the raw error", async () => {
    const guidance = await agentFailureGuidance(
      "claude-code",
      "Authentication required",
      async () => true,
    );
    expect(guidance).toBe(REMEDIATION);
  });

  it("returns null for errors that aren't auth-shaped", async () => {
    expect(
      await agentFailureGuidance("claude-code", "You've hit your spend limit", async () => true),
    ).toBeNull();
  });
});
