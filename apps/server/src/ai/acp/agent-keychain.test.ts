import { describe, expect, it } from "bun:test";
import { platform } from "node:os";
import { getAgentKeychainAuth } from "@revv/shared";
import {
  looksLikeAuthFailure,
  probeAgentKeychainReadable,
  withAgentKeychainHint,
} from "./agent-keychain";

const isMac = platform() === "darwin";

describe("registry keychainAuth", () => {
  it("declares claude-code as keychain-backed and the file-based agents as not", () => {
    expect(getAgentKeychainAuth("claude-code")?.service).toBe("Claude Code-credentials");
    expect(getAgentKeychainAuth("opencode")).toBeUndefined();
    expect(getAgentKeychainAuth("codex")).toBeUndefined();
    expect(getAgentKeychainAuth("cursor")).toBeUndefined();
  });
});

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

describe("withAgentKeychainHint", () => {
  // `isLoggedIn` is the test seam (3rd arg) — every case below pins it
  // explicitly so the assertions never depend on this machine's real Claude
  // Code / Codex / Cursor login state.

  it("leads with the keychain remediation ALONE when the agent reports logged in", () => {
    const out = withAgentKeychainHint("claude-code", "ACP connection closed", () => true);
    expect(out).toContain("ACP connection closed");
    expect(out).toContain(getAgentKeychainAuth("claude-code")?.remediation ?? " ");
    expect(out).not.toContain("isn't logged in for this session");
  });

  it("leads with 'not logged in' when the agent reports logged out, with the keychain hint as a secondary fallback", () => {
    const out = withAgentKeychainHint("claude-code", "ACP connection closed", () => false);
    expect(out).toContain("ACP connection closed");
    expect(out).toContain("Claude Code agent isn't logged in for this session");
    expect(out).toContain("sign in to Claude Code");
    // The keychain remediation still appears, but only behind the fallback framing.
    expect(out).toContain("Already signed in?");
    expect(out).toContain(getAgentKeychainAuth("claude-code")?.remediation ?? " ");
  });

  it("shows the not-logged-in message with NO keychain text for a non-keychain-backed agent", () => {
    const out = withAgentKeychainHint("codex", "401 unauthorized", () => false);
    expect(out).toContain("401 unauthorized");
    expect(out).toContain("Codex agent isn't logged in for this session");
    expect(out).not.toContain("Keychain");
  });

  it("never touches an authenticated non-keychain-backed agent's error", () => {
    expect(withAgentKeychainHint("opencode", "ACP connection closed", () => true)).toBe(
      "ACP connection closed",
    );
    expect(withAgentKeychainHint("codex", "401 unauthorized", () => true)).toBe("401 unauthorized");
  });

  it("leaves non-auth errors unchanged regardless of login state", () => {
    expect(withAgentKeychainHint("claude-code", "ENOENT: spawn failed", () => false)).toBe(
      "ENOENT: spawn failed",
    );
  });

  it("falls back to the real detectAgentAuth-based probe when no test seam is supplied (smoke test)", () => {
    // Only asserts it runs to completion and returns a string on this machine
    // — the actual auth state is environment-dependent, so this doesn't
    // assert which branch fired.
    const out = withAgentKeychainHint("claude-code", "ACP connection closed");
    expect(typeof out).toBe("string");
    expect(out).toContain("ACP connection closed");
    expect(isMac).toBe(true);
  });
});

describe("probeAgentKeychainReadable", () => {
  // Regression coverage for the bug this fixes: the probe used to run a raw,
  // unscoped Keychain existence check that couldn't see an isolated
  // `CLAUDE_CONFIG_DIR`'s own scoped item, so it always reported `false` under
  // isolation regardless of whether the user was actually logged in. It now
  // delegates to the SAME context-aware auth check `withAgentKeychainHint`
  // uses, via the same `isLoggedIn` test seam.

  it("reports the probe's verdict directly for a keychain-backed agent", async () => {
    expect(await probeAgentKeychainReadable("claude-code", () => true)).toBe(true);
    expect(await probeAgentKeychainReadable("claude-code", () => false)).toBe(false);
  });

  it("returns null for agents that aren't keychain-backed, regardless of login state", async () => {
    expect(await probeAgentKeychainReadable("opencode", () => true)).toBeNull();
    expect(await probeAgentKeychainReadable("codex", () => false)).toBeNull();
    expect(await probeAgentKeychainReadable("cursor", () => true)).toBeNull();
  });

  it("falls back to the real detectAgentAuth-based probe when no test seam is supplied (smoke test)", async () => {
    const readable = await probeAgentKeychainReadable("claude-code");
    expect(typeof readable).toBe("boolean");
    expect(isMac).toBe(true);
  });
});
