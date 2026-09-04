import { describe, expect, it } from "bun:test";
import { makeActivityBeacon, withAgentTurn } from "./agent-turn";

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

  it("aborts on the idle deadline when the agent stops producing activity", async () => {
    const activity = makeActivityBeacon();
    let aborts = 0;

    await expect(
      withAgentTurn({
        hardTimeoutMs: 10_000,
        idleTimeoutMs: 20,
        activity,
        debugLabel: "agent-turn-test",
        jobStarted: async () => {},
        jobEnded: async () => {},
        abortSession: async () => {
          aborts += 1;
        },
        run: async () => new Promise<never>(() => {}),
      }),
    ).rejects.toThrow("Agent stopped responding");

    expect(aborts).toBe(1);
  });

  it("keeps a long turn alive while activity keeps arriving", async () => {
    const activity = makeActivityBeacon();
    const ticker = setInterval(() => activity.note(), 5);

    try {
      // Idle deadline (20ms) is well under the ceiling (150ms): reaching the
      // ceiling proves every note rearmed the idle timer instead of letting it
      // kill a still-working agent.
      await expect(
        withAgentTurn({
          hardTimeoutMs: 150,
          idleTimeoutMs: 20,
          activity,
          debugLabel: "agent-turn-test",
          jobStarted: async () => {},
          jobEnded: async () => {},
          run: async () => new Promise<never>(() => {}),
        }),
      ).rejects.toThrow("Agent turn timed out");
    } finally {
      clearInterval(ticker);
    }
  });

  it("ignores idleTimeoutMs without an activity beacon", async () => {
    // No beacon means nothing could rearm the timer, so arming it would just be
    // a second, shorter ceiling — the exact over-aggressive behaviour this
    // option exists to avoid.
    await expect(
      withAgentTurn({
        hardTimeoutMs: 40,
        idleTimeoutMs: 5,
        debugLabel: "agent-turn-test",
        jobStarted: async () => {},
        jobEnded: async () => {},
        run: async () => new Promise<never>(() => {}),
      }),
    ).rejects.toThrow("Agent turn timed out");
  });
});
