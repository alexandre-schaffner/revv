import { describe, expect, it } from "bun:test";
import { makePollState, rankThreadSweep, type ThreadSweepMark } from "./poll-state";

const NOW = Date.parse("2026-06-04T12:00:00.000Z");
const MINUTE = 60 * 1000;

const pr = (id: string, updatedAt = "2026-06-04T10:00:00.000Z") => ({ id, updatedAt });

describe("rankThreadSweep", () => {
  it("sweeps moved PRs first, then never-swept ones", () => {
    const marks = new Map<string, ThreadSweepMark>([
      ["moved", { updatedAt: "2026-06-04T09:00:00.000Z", sweptAt: NOW - 5 * MINUTE }],
    ]);
    const ranked = rankThreadSweep([pr("unseen"), pr("moved")], marks, NOW);
    expect(ranked.map((r) => [r.pr.id, r.recheck])).toEqual([
      ["moved", false],
      ["unseen", false],
    ]);
  });

  it("leaves an unchanged PR alone until the recheck interval has passed", () => {
    const marks = new Map<string, ThreadSweepMark>([
      ["recent", { updatedAt: "2026-06-04T10:00:00.000Z", sweptAt: NOW - 5 * MINUTE }],
    ]);
    expect(rankThreadSweep([pr("recent")], marks, NOW)).toEqual([]);
  });

  it("rechecks unchanged PRs after the interval, oldest sweep first, after the rest", () => {
    const marks = new Map<string, ThreadSweepMark>([
      ["newer", { updatedAt: "2026-06-04T10:00:00.000Z", sweptAt: NOW - 40 * MINUTE }],
      ["older", { updatedAt: "2026-06-04T10:00:00.000Z", sweptAt: NOW - 90 * MINUTE }],
    ]);
    const ranked = rankThreadSweep([pr("newer"), pr("older"), pr("unseen")], marks, NOW);
    expect(ranked.map((r) => [r.pr.id, r.recheck])).toEqual([
      ["unseen", false],
      ["older", true],
      ["newer", true],
    ]);
  });
});

describe("claimCycle", () => {
  it("queues one more cycle when a manual sync coalesces onto the one in flight", () => {
    const state = makePollState();
    expect(state.claimCycle("periodic", NOW)).toBe("claimed");
    expect(state.claimCycle("manual", NOW)).toBe("in-flight");
    expect(state.claimCycle("manual", NOW)).toBe("in-flight");
    expect(state.releaseCycle()).toBe(true);
    expect(state.claimCycle("manual", NOW)).toBe("claimed");
    expect(state.releaseCycle()).toBe(false);
  });

  it("drops a coalesced freshen or periodic request", () => {
    const state = makePollState();
    expect(state.claimCycle("manual", NOW)).toBe("claimed");
    expect(state.claimCycle("freshen", NOW)).toBe("in-flight");
    expect(state.claimCycle("periodic", NOW)).toBe("in-flight");
    expect(state.releaseCycle()).toBe(false);
    expect(state.claimCycle("freshen", NOW + MINUTE)).toBe("fresh-enough");
  });
});
