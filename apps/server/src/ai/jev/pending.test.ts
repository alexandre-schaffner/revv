import { describe, expect, it } from "bun:test";
import {
  awaitJudgments,
  forgetWalkthrough,
  markRetracted,
  pendingCount,
  trackJudgment,
  wasRetracted,
} from "./pending";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("pending judgments", () => {
  it("drains work scheduled before the gate ran", async () => {
    const id = `w-${crypto.randomUUID()}`;
    let landed = false;
    trackJudgment(
      id,
      tick(10).then(() => {
        landed = true;
      }),
    );
    expect(landed).toBe(false);
    await awaitJudgments(id);
    expect(landed).toBe(true);
    expect(pendingCount(id)).toBe(0);
    forgetWalkthrough(id);
  });

  // A judgment can be scheduled mid-drain; one `Promise.all` over a single
  // snapshot would miss it.
  it("drains work scheduled during the drain", async () => {
    const id = `w-${crypto.randomUUID()}`;
    let second = false;
    trackJudgment(
      id,
      tick(5).then(() => {
        trackJudgment(
          id,
          tick(5).then(() => {
            second = true;
          }),
        );
      }),
    );
    await awaitJudgments(id);
    expect(second).toBe(true);
    forgetWalkthrough(id);
  });

  // A rejected judgment must not wedge the gate that later drains it.
  it("survives a rejected judgment", async () => {
    const id = `w-${crypto.randomUUID()}`;
    trackJudgment(id, Promise.reject(new Error("boom")));
    await awaitJudgments(id);
    expect(pendingCount(id)).toBe(0);
    forgetWalkthrough(id);
  });

  it("returns immediately when nothing is in flight", async () => {
    const id = `w-${crypto.randomUUID()}`;
    await awaitJudgments(id);
    expect(pendingCount(id)).toBe(0);
  });

  it("tracks retractions per walkthrough and forgets them on job end", () => {
    const a = `w-${crypto.randomUUID()}`;
    const b = `w-${crypto.randomUUID()}`;
    markRetracted(a, "issue-1");
    expect(wasRetracted(a, "issue-1")).toBe(true);
    expect(wasRetracted(b, "issue-1")).toBe(false);
    forgetWalkthrough(a);
    expect(wasRetracted(a, "issue-1")).toBe(false);
  });
});
