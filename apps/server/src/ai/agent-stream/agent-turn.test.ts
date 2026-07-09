import { describe, expect, it } from "bun:test";
import { withAgentTurn } from "./agent-turn";

describe("withAgentTurn", () => {
  it("settles on hard timeout even when the provider ignores the abort signal", async () => {
    let started = 0;
    let ended = 0;
    let aborts = 0;
    const startedAt = Date.now();

    await expect(
      withAgentTurn({
        hardTimeoutMs: 20,
        debugLabel: "agent-turn-test",
        jobStarted: async () => {
          started += 1;
        },
        jobEnded: async () => {
          ended += 1;
        },
        abortSession: async () => {
          aborts += 1;
        },
        run: async () => new Promise<never>(() => {}),
      }),
    ).rejects.toThrow("Agent turn timed out");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(started).toBe(1);
    expect(ended).toBe(1);
    expect(aborts).toBe(1);
  });

  it("settles when the external abort fires even when the provider keeps waiting", async () => {
    const abortController = new AbortController();
    let ended = 0;
    let aborts = 0;

    setTimeout(() => abortController.abort(new Error("manual stop")), 20);

    await expect(
      withAgentTurn({
        externalAbort: abortController,
        hardTimeoutMs: 1_000,
        debugLabel: "agent-turn-test",
        jobStarted: async () => {},
        jobEnded: async () => {
          ended += 1;
        },
        abortSession: async () => {
          aborts += 1;
        },
        run: async () => new Promise<never>(() => {}),
      }),
    ).rejects.toThrow("manual stop");

    expect(ended).toBe(1);
    expect(aborts).toBe(1);
  });
});
