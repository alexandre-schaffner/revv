import { describe, expect, it } from "bun:test";
import { rankThreadSweep, type ThreadSweepMark } from "./PollScheduler";

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

  // An unresolved thread used to put a PR in every 5-minute sweep forever,
  // each one a billed GraphQL call.
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
