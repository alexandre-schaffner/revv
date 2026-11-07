import { describe, expect, it } from "bun:test";
import { AgentTurnError } from "../acp/agent-failure";
import { checkAgent } from "./agent-check";

const input = { agent: "claude-code", model: "claude-sonnet-5-5", thinkingEffort: "low" } as const;

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

  it("splits a runner failure into the agent's error and its guidance", async () => {
    const result = await checkAgent(input, async () => {
      throw new AgentTurnError("401 Unauthorized", "auth", "Sign in again.");
    });
    expect(result).toEqual({ ok: false, error: "401 Unauthorized", guidance: "Sign in again." });
  });
});
