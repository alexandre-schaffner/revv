import { describe, expect, it } from "bun:test";
import { canonicalRecapBoundaries, windowIsCurrent } from "./RecapScheduler";

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

// Pinning tests: these were the inline conditions inside
// canonicalRecapBoundaries before windowIsCurrent was extracted out of it.
describe("canonicalRecapBoundaries", () => {
  it("rolls the end boundary to `now` for the current day", () => {
    expect(canonicalRecapBoundaries("daily", "2026-06-04T00:00:00.000Z", NOW)).toEqual({
      periodStart: "2026-06-04T00:00:00.000Z",
      periodEnd: "2026-06-04T09:30:00.000Z",
    });
  });

  it("rolls the end boundary to `now` for the current week, from any day in it", () => {
    expect(canonicalRecapBoundaries("weekly", "2026-06-04T00:00:00.000Z", NOW)).toEqual({
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-06-04T09:30:00.000Z",
    });
  });

  it("returns a closed full day for a historical daily window", () => {
    expect(canonicalRecapBoundaries("daily", "2026-06-02T13:00:00.000Z", NOW)).toEqual({
      periodStart: "2026-06-02T00:00:00.000Z",
      periodEnd: "2026-06-03T00:00:00.000Z",
    });
  });

  it("returns a closed full week for a historical weekly window", () => {
    expect(canonicalRecapBoundaries("weekly", "2026-05-27T13:00:00.000Z", NOW)).toEqual({
      periodStart: "2026-05-25T00:00:00.000Z",
      periodEnd: "2026-06-01T00:00:00.000Z",
    });
  });
});
