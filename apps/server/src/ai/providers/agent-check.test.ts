import { describe, expect, it } from "bun:test";
import { checkAgent } from "./agent-check";

const input = { agent: "claude-code", model: "claude-sonnet-5-5", thinkingEffort: "low" } as const;

describe("checkAgent", () => {
  it("passes when the turn completes", async () => {
    expect(await checkAgent(input, async () => ({ kind: "answered", text: "OK" }))).toEqual({
      ok: true,
    });
  });

  it("splits a failed turn into the agent's error and its guidance", async () => {
    const result = await checkAgent(input, async () => ({
      kind: "failed",
      error: "401 Unauthorized",
      guidance: "Sign in again.",
    }));
    expect(result).toEqual({ ok: false, error: "401 Unauthorized", guidance: "Sign in again." });
  });
});
