import { describe, expect, test } from "bun:test";
import { buildPrFlow, buildRepoActivity } from "./RepoActivity";

const NOW = new Date("2026-10-16T12:00:00Z");
// Sunday 2026-10-11 and the Sunday before it, in Unix seconds.
const W1 = Date.UTC(2026, 9, 4) / 1000;
const W2 = Date.UTC(2026, 9, 11) / 1000;

describe("buildRepoActivity", () => {
  test("joins code frequency onto commit weeks and flips deletions positive", () => {
    const activity = buildRepoActivity(
      [
        { week: W1, days: [0, 1, 2, 3, 4, 5, 6] },
        { week: W2, days: [1, 0, 0, 0, 0] },
      ],
      { kind: "ready", data: [[W2, 120, -40]] },
      NOW,
    );
    if (activity.status !== "ready") throw new Error("expected ready");
    expect(activity.weeks).toEqual([
      { weekStart: "2026-10-04", days: [0, 1, 2, 3, 4, 5, 6], additions: 0, deletions: 0 },
      { weekStart: "2026-10-11", days: [1, 0, 0, 0, 0, 0, 0], additions: 120, deletions: 40 },
    ]);
  });

  test("leaves churn null when GitHub won't compute code frequency", () => {
    const activity = buildRepoActivity(
      [{ week: W2, days: [0, 0, 0, 0, 0, 0, 0] }],
      { kind: "unavailable" },
      NOW,
    );
    if (activity.status !== "ready") throw new Error("expected ready");
    expect(activity.weeks[0]?.additions).toBeNull();
    expect(activity.weeks[0]?.deletions).toBeNull();
  });

  test("an empty repo still gets a year of empty weeks ending this week", () => {
    const activity = buildRepoActivity([], { kind: "ready", data: [] }, NOW);
    if (activity.status !== "ready") throw new Error("expected ready");
    expect(activity.weeks).toHaveLength(52);
    expect(activity.weeks.at(-1)?.weekStart).toBe("2026-10-11");
  });
});

describe("buildPrFlow", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const ago = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  test("splits merges and openings into weeks and takes the median time to merge", () => {
    const flow = buildPrFlow(
      {
        total: 3,
        items: [
          { number: 1, authorLogin: "a", createdAt: ago(3), mergedAt: ago(2) }, // 24h
          { number: 2, authorLogin: "A", createdAt: ago(10), mergedAt: ago(9) }, // 24h
          { number: 3, authorLogin: "b", createdAt: ago(26), mergedAt: ago(22) }, // 96h
        ],
      },
      {
        total: 2,
        items: [
          { number: 4, authorLogin: "c", createdAt: ago(1), mergedAt: null },
          { number: 1, authorLogin: "a", createdAt: ago(3), mergedAt: ago(2) },
        ],
      },
      now,
    );
    expect(flow).toEqual({
      mergedLast7d: 1,
      mergedPrev7d: 1,
      openedLast7d: 2,
      openedPrev7d: 0,
      medianHoursToMerge: 24,
      medianSample: 3,
      mergedLast28d: 3,
      authorsLast28d: 2,
      mergedPerWeek: [1, 0, 1, 1],
    });
  });

  test("exact counts win over a truncated page", () => {
    const empty = { total: 500, items: [] };
    const flow = buildPrFlow(empty, empty, now, { mergedLast7d: 120, openedPrev7d: 80 });
    expect(flow.mergedLast7d).toBe(120);
    expect(flow.openedPrev7d).toBe(80);
    expect(flow.medianHoursToMerge).toBeNull();
  });
});
