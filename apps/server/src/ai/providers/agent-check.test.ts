import { describe, expect, it } from "bun:test";
import { getAgentKeychainAuth } from "@revv/shared";
import { checkAgent } from "./agent-check";

const input = { agent: "claude-code", model: "claude-sonnet-5-5", cwd: "/tmp" } as const;

describe("checkAgent", () => {
  it("passes when the turn completes", async () => {
    expect(await checkAgent(input, async () => "OK")).toEqual({ ok: true });
  });

  it("reports the agent's own error for a non-auth failure, with no guidance", async () => {
    const result = await checkAgent(input, async () => {
      throw new Error("Internal error: You've hit your spend limit");
    });
    expect(result).toEqual({
      ok: false,
      error: "Internal error: You've hit your spend limit",
      guidance: null,
    });
  });

  it("adds sign-in or Keychain guidance for an auth failure", async () => {
    const result = await checkAgent(input, async () => {
      throw new Error("Authentication required");
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Authentication required");
    // Which guidance leads depends on this machine's login state; either way
    // it carries the registry's Keychain remediation.
    expect(result.guidance).toContain(getAgentKeychainAuth("claude-code")?.remediation ?? " ");
  });

  it("fails a turn that never answers", async () => {
    const result = await checkAgent(input, () => new Promise(() => {}), 10);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("didn't answer") });
  });
});
