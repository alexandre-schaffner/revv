import { describe, expect, it } from "bun:test";
import { makeJudgmentTracker } from "./pending";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("judgment tracker", () => {
  it("drains work scheduled before the gate ran", async () => {
    const tracker = makeJudgmentTracker("w");
    let landed = false;
    tracker.track(
      tick(10).then(() => {
        landed = true;
      }),
    );
    expect(landed).toBe(false);
    await tracker.drain();
    expect(landed).toBe(true);
    expect(tracker.pending()).toBe(0);
  });

  // A judgment can be scheduled mid-drain; one `Promise.all` over a single
  // snapshot would miss it.
  it("drains work scheduled during the drain", async () => {
    const tracker = makeJudgmentTracker("w");
    let second = false;
    tracker.track(
      tick(5).then(() => {
        tracker.track(
          tick(5).then(() => {
            second = true;
          }),
        );
      }),
    );
    await tracker.drain();
    expect(second).toBe(true);
  });

  // A rejected judgment must not wedge the gate that later drains it.
  it("survives a rejected judgment", async () => {
    const tracker = makeJudgmentTracker("w");
    tracker.track(Promise.reject(new Error("boom")));
    await tracker.drain();
    expect(tracker.pending()).toBe(0);
  });

  it("returns immediately when nothing is in flight", async () => {
    const tracker = makeJudgmentTracker("w");
    await tracker.drain();
    expect(tracker.pending()).toBe(0);
  });

  it("keeps retractions per run", () => {
    const a = makeJudgmentTracker("a");
    const b = makeJudgmentTracker("b");
    a.markRetracted("issue-1");
    expect(a.wasRetracted("issue-1")).toBe(true);
    expect(b.wasRetracted("issue-1")).toBe(false);
  });
});
