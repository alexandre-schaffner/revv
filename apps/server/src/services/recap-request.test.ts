import { describe, expect, it } from "bun:test";
import { canonicalWindow, closedWindows, windowIsCurrent } from "@revv/shared";
import { planRecapRequest } from "./recap-request";

// 2026-06-04 is a Thursday; its ISO week opens on Monday 2026-06-01.
const NOW = new Date("2026-06-04T09:30:00.000Z");

describe("windowIsCurrent", () => {
  it("is today, and only today, for daily", () => {
    expect(windowIsCurrent("daily", "2026-06-04T00:00:00.000Z", NOW)).toBe(true);
    expect(windowIsCurrent("daily", "2026-06-04T23:59:00.000Z", NOW)).toBe(true);
    expect(windowIsCurrent("daily", "2026-06-03T00:00:00.000Z", NOW)).toBe(false);
    expect(windowIsCurrent("daily", "2026-06-05T00:00:00.000Z", NOW)).toBe(false);
  });

  it("is the whole current ISO week for weekly", () => {
    expect(windowIsCurrent("weekly", "2026-06-01T00:00:00.000Z", NOW)).toBe(true);
    expect(windowIsCurrent("weekly", "2026-06-07T00:00:00.000Z", NOW)).toBe(true);
    expect(windowIsCurrent("weekly", "2026-05-31T00:00:00.000Z", NOW)).toBe(false);
    expect(windowIsCurrent("weekly", "2026-06-08T00:00:00.000Z", NOW)).toBe(false);
  });
});

describe("canonicalWindow", () => {
  it("rolls the end boundary to `now` for the current day", () => {
    expect(canonicalWindow("daily", "2026-06-04T00:00:00.000Z", NOW)).toEqual({
      periodStart: "2026-06-04T00:00:00.000Z",
      periodEnd: "2026-06-04T09:30:00.000Z",
    });
  });

  it("rolls the end boundary to `now` for the current week, from any day in it", () => {
    expect(canonicalWindow("weekly", "2026-06-04T00:00:00.000Z", NOW)).toEqual({
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-06-04T09:30:00.000Z",
    });
  });

  it("returns a closed full day for a historical daily window", () => {
    expect(canonicalWindow("daily", "2026-06-02T13:00:00.000Z", NOW)).toEqual({
      periodStart: "2026-06-02T00:00:00.000Z",
      periodEnd: "2026-06-03T00:00:00.000Z",
    });
  });

  it("returns a closed full week for a historical weekly window", () => {
    expect(canonicalWindow("weekly", "2026-05-27T13:00:00.000Z", NOW)).toEqual({
      periodStart: "2026-05-25T00:00:00.000Z",
      periodEnd: "2026-06-01T00:00:00.000Z",
    });
  });
});

describe("closedWindows", () => {
  it("lists the closed days newest first, starting with yesterday", () => {
    expect(closedWindows("daily", NOW, 2)).toEqual([
      { periodStart: "2026-06-03T00:00:00.000Z", periodEnd: "2026-06-04T00:00:00.000Z" },
      { periodStart: "2026-06-02T00:00:00.000Z", periodEnd: "2026-06-03T00:00:00.000Z" },
    ]);
  });

  it("starts weekly with last week", () => {
    expect(closedWindows("weekly", NOW, 1)).toEqual([
      { periodStart: "2026-05-25T00:00:00.000Z", periodEnd: "2026-06-01T00:00:00.000Z" },
    ]);
  });
});

describe("planRecapRequest", () => {
  const [yesterday, threeDaysAgo] = [
    closedWindows("daily", NOW, 1)[0],
    closedWindows("daily", NOW, 3)[2],
  ];
  if (!yesterday || !threeDaysAgo) throw new Error("expected closed windows");
  const lastWeek = closedWindows("weekly", NOW, 1)[0];
  if (!lastWeek) throw new Error("expected a closed week");
  const base = { period: "daily", window: yesterday, rolling: false, now: NOW } as const;

  it("creates a recap for a window without one, whatever the intent", () => {
    for (const intent of ["scheduled", "manual", "regenerate"] as const) {
      expect(planRecapRequest({ ...base, intent, existing: null })).toBe("create");
    }
  });

  it("reruns a scheduled recap of the latest closed window written before it closed", () => {
    const existing = { generatedAt: "2026-06-03T16:00:00.000Z" };
    expect(planRecapRequest({ ...base, intent: "scheduled", existing })).toBe("rerun");
    expect(
      planRecapRequest({
        ...base,
        period: "weekly",
        window: lastWeek,
        intent: "scheduled",
        existing: { generatedAt: "2026-05-29T10:00:00.000Z" },
      }),
    ).toBe("rerun");
  });

  it("keeps a scheduled recap written after its window closed, or of an older window", () => {
    expect(
      planRecapRequest({
        ...base,
        intent: "scheduled",
        existing: { generatedAt: "2026-06-04T00:15:00.000Z" },
      }),
    ).toBe("reuse");
    expect(
      planRecapRequest({
        ...base,
        window: threeDaysAgo,
        intent: "scheduled",
        existing: { generatedAt: "2026-06-01T16:00:00.000Z" },
      }),
    ).toBe("reuse");
  });

  it("reruns the open window on a manual request and reuses a pinned one", () => {
    const existing = { generatedAt: "2026-06-04T08:00:00.000Z" };
    expect(planRecapRequest({ ...base, rolling: true, intent: "manual", existing })).toBe("rerun");
    expect(planRecapRequest({ ...base, intent: "manual", existing })).toBe("reuse");
    expect(planRecapRequest({ ...base, intent: "regenerate", existing })).toBe("rerun");
  });
});
