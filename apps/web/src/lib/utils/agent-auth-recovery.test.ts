import { describe, expect, it } from "bun:test";
import { agentAuthRecoveryDescription } from "./agent-auth-recovery";

const KEYCHAIN_REMEDIATION =
  "Revv's background service isn't allowed to read your Claude subscription login from the macOS Keychain.";

describe("agentAuthRecoveryDescription", () => {
  it("keeps the agent's own error and drops the server's appended guidance", () => {
    const description = agentAuthRecoveryDescription(
      `ACP connection closed\n\n${KEYCHAIN_REMEDIATION}`,
    );
    expect(description).toContain("run the agent test");
    expect(description).toEndWith("Agent error: ACP connection closed");
    expect(description).not.toContain("subscription login");
  });

  it("shows the raw error", () => {
    expect(agentAuthRecoveryDescription("401 unauthorized")).toBe(
      "Reconnect the agent in Settings. If it is already connected, run the agent test there to see what fails. Agent error: 401 unauthorized",
    );
  });

  it("truncates a long error", () => {
    const description = agentAuthRecoveryDescription(`oauth ${"x".repeat(500)}`);
    expect(description.length).toBeLessThan(320);
    expect(description).toEndWith("…");
  });
});
