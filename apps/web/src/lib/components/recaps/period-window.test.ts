import { describe, expect, it } from "bun:test";
import {
  addUtcDays,
  dayKeyToUtcDate,
  formatPeriod,
  isCurrentPeriod,
  mondayKeyOf,
  monthGrid,
  monthGridRange,
  monthKeyOf,
  pickLatestByWindow,
  recapSlotKey,
  recapWindowIsStale,
  selectionBoundaries,
  shiftMonth,
  slotKeyFor,
  utcDayKey,
} from "./period-window";

describe("dayKeyToUtcDate", () => {
  it("parses a day key as UTC midnight, not local midnight", () => {
    const d = dayKeyToUtcDate("2026-06-03");
    expect(d.toISOString()).toBe("2026-06-03T00:00:00.000Z");
    // The trap this helper exists to avoid: the string below is local time.
    expect(d.getTime()).toBe(Date.parse("2026-06-03"));
  });
});

describe("addUtcDays", () => {
  it("crosses a month boundary", () => {
    expect(addUtcDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(addUtcDays("2026-07-01", -1)).toBe("2026-06-30");
  });

  it("crosses a year boundary", () => {
    expect(addUtcDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addUtcDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("handles leap-year February", () => {
    expect(addUtcDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addUtcDays("2028-02-29", 1)).toBe("2028-03-01");
    expect(addUtcDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("monthKeyOf / shiftMonth", () => {
  it("reads a month key off any accepted value shape", () => {
    expect(monthKeyOf("2026-06-03")).toBe("2026-06");
    expect(monthKeyOf("2026-06-03T12:00:00.000Z")).toBe("2026-06");
    expect(monthKeyOf(new Date(Date.UTC(2026, 5, 3)))).toBe("2026-06");
  });

  it("rolls across years in both directions", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-06", -18)).toBe("2024-12");
    expect(shiftMonth("2026-06", 0)).toBe("2026-06");
  });
});

describe("mondayKeyOf", () => {
  it("snaps to the Monday on-or-before, treating Sunday as the week's end", () => {
    // 2026-06-01 is a Monday; 2026-06-07 is the Sunday that closes that week.
    expect(mondayKeyOf("2026-06-01")).toBe("2026-06-01");
    expect(mondayKeyOf("2026-06-04")).toBe("2026-06-01");
    expect(mondayKeyOf("2026-06-07")).toBe("2026-06-01");
    expect(mondayKeyOf("2026-06-08")).toBe("2026-06-08");
  });
});

describe("monthGrid", () => {
  it("starts on the 1st when the month begins on a Monday", () => {
    // June 2026 starts on a Monday — no leading days from May.
    const { weeks, fromKey, toKeyExclusive } = monthGrid("2026-06");
    expect(fromKey).toBe("2026-06-01");
    expect(weeks[0]?.[0]).toBe("2026-06-01");
    expect(toKeyExclusive).toBe("2026-07-13");
  });

  it("backs up to the previous Monday when the month begins on a Sunday", () => {
    // March 2026 starts on a Sunday, so the grid opens on 2026-02-23.
    const { weeks, fromKey } = monthGrid("2026-03");
    expect(fromKey).toBe("2026-02-23");
    expect(weeks[0]?.[6]).toBe("2026-03-01");
  });

  it("always returns 6 rows of 7 contiguous days", () => {
    for (const monthKey of ["2026-01", "2026-02", "2026-03", "2028-02", "2026-11", "2026-12"]) {
      const { weeks, fromKey } = monthGrid(monthKey);
      expect(weeks).toHaveLength(6);
      for (const week of weeks) expect(week).toHaveLength(7);
      const flat = weeks.flat();
      expect(flat).toHaveLength(42);
      expect(flat[0]).toBe(fromKey);
      for (let i = 1; i < flat.length; i++) {
        expect(flat[i]).toBe(addUtcDays(flat[i - 1] as string, 1));
      }
    }
  });

  it("covers leap-day February", () => {
    const flat = monthGrid("2028-02").weeks.flat();
    expect(flat).toContain("2028-02-29");
  });

  it("rolls December into January", () => {
    const flat = monthGrid("2026-12").weeks.flat();
    expect(flat).toContain("2026-12-31");
    expect(flat).toContain("2027-01-01");
  });
});

describe("monthGridRange", () => {
  it("spans the grid, not the calendar month", () => {
    // March 2026 opens on 2026-02-23, so the query must reach back into Feb
    // or weekly rows whose Monday sits in the previous month go missing.
    const { from, to } = monthGridRange("2026-03");
    expect(from).toBe("2026-02-23T00:00:00.000Z");
    expect(to).toBe("2026-04-06T00:00:00.000Z");
  });

  it("is half-open: the exclusive end is the day after the last cell", () => {
    const { weeks } = monthGrid("2026-06");
    const lastCell = weeks[5]?.[6] as string;
    expect(monthGridRange("2026-06").to).toBe(
      dayKeyToUtcDate(addUtcDays(lastCell, 1)).toISOString(),
    );
  });
});

describe("slot keys", () => {
  it("keys a daily recap on its own day and a weekly one on its Monday", () => {
    expect(
      recapSlotKey({
        period: "daily",
        periodStart: "2026-06-03T00:00:00.000Z",
        periodEnd: "2026-06-04T00:00:00.000Z",
      }),
    ).toBe("daily:2026-06-03");
    expect(
      recapSlotKey({
        period: "weekly",
        periodStart: "2026-06-01T00:00:00.000Z",
        periodEnd: "2026-06-08T00:00:00.000Z",
      }),
    ).toBe("weekly:2026-06-01");
  });

  it("matches the key any cell in a weekly row computes", () => {
    for (const day of ["2026-06-01", "2026-06-04", "2026-06-07"]) {
      expect(slotKeyFor("weekly", day)).toBe("weekly:2026-06-01");
    }
    expect(slotKeyFor("daily", "2026-06-04")).toBe("daily:2026-06-04");
  });

  it("survives a Date-valued periodStart (Eden revives ISO strings to Date)", () => {
    expect(
      recapSlotKey({
        period: "daily",
        periodStart: new Date("2026-06-03T00:00:00.000Z"),
        periodEnd: new Date("2026-06-04T00:00:00.000Z"),
      }),
    ).toBe("daily:2026-06-03");
  });
});

describe("isCurrentPeriod", () => {
  const now = new Date("2026-06-04T09:30:00.000Z"); // a Thursday

  it("is today for daily", () => {
    expect(isCurrentPeriod("daily", "2026-06-04", now)).toBe(true);
    expect(isCurrentPeriod("daily", "2026-06-03", now)).toBe(false);
  });

  it("is the whole current ISO week for weekly", () => {
    expect(isCurrentPeriod("weekly", "2026-06-01", now)).toBe(true);
    expect(isCurrentPeriod("weekly", "2026-06-07", now)).toBe(true);
    expect(isCurrentPeriod("weekly", "2026-05-31", now)).toBe(false);
    expect(isCurrentPeriod("weekly", "2026-06-08", now)).toBe(false);
  });
});

describe("selectionBoundaries", () => {
  const now = new Date("2026-06-04T09:30:00.000Z"); // Thursday

  it("pins a past daily window to [day, day+1)", () => {
    expect(selectionBoundaries("daily", "2026-06-02", now)).toEqual({
      periodStart: "2026-06-02T00:00:00.000Z",
      periodEnd: "2026-06-03T00:00:00.000Z",
    });
  });

  it("pins a past weekly window to [monday, monday+7d) from any day in it", () => {
    const expected = {
      periodStart: "2026-05-25T00:00:00.000Z",
      periodEnd: "2026-06-01T00:00:00.000Z",
    };
    expect(selectionBoundaries("weekly", "2026-05-25", now)).toEqual(expected);
    expect(selectionBoundaries("weekly", "2026-05-29", now)).toEqual(expected);
  });

  it("returns null for today so the server rolls its own window", () => {
    expect(selectionBoundaries("daily", "2026-06-04", now)).toBeNull();
  });

  it("returns null for any day in the current week", () => {
    expect(selectionBoundaries("weekly", "2026-06-01", now)).toBeNull();
    expect(selectionBoundaries("weekly", "2026-06-07", now)).toBeNull();
  });

  it("crosses a year boundary without drifting", () => {
    expect(selectionBoundaries("daily", "2025-12-31", now)).toEqual({
      periodStart: "2025-12-31T00:00:00.000Z",
      periodEnd: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("recapWindowIsStale", () => {
  // Pinning tests: behaviour must not move when this was lifted out of
  // RecapPeriodView.svelte and re-expressed on top of isCurrentPeriod.
  it("is true for a closed full day, whatever the date", () => {
    expect(
      recapWindowIsStale({
        period: "daily",
        periodStart: "2026-06-03T00:00:00.000Z",
        periodEnd: "2026-06-04T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("is true for a closed full week", () => {
    expect(
      recapWindowIsStale({
        period: "weekly",
        periodStart: "2026-06-01T00:00:00.000Z",
        periodEnd: "2026-06-08T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("is false for a rolling window over today", () => {
    const now = new Date();
    const start = `${utcDayKey(now)}T00:00:00.000Z`;
    expect(
      recapWindowIsStale({ period: "daily", periodStart: start, periodEnd: now.toISOString() }),
    ).toBe(false);
  });

  it("is true for a rolling window that started on an earlier day", () => {
    expect(
      recapWindowIsStale({
        period: "daily",
        periodStart: "2020-01-01T00:00:00.000Z",
        periodEnd: "2020-01-01T18:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("tolerates unparseable boundaries rather than throwing", () => {
    expect(
      recapWindowIsStale({ period: "daily", periodStart: "nonsense", periodEnd: "nonsense" }),
    ).toBe(true);
  });
});

describe("pickLatestByWindow", () => {
  const row = (
    id: string,
    period: "daily" | "weekly",
    periodStart: string,
    generatedAt: string,
    status = "complete",
  ) => ({
    id,
    period,
    periodStart,
    periodEnd: periodStart,
    generatedAt,
    status,
  });

  it("prefers the latest window over the latest generation", () => {
    const recaps = [
      // Generated just now, but covers a window three weeks back.
      row("backfill", "daily", "2026-05-15T00:00:00.000Z", "2026-06-04T10:00:00.000Z"),
      row("today", "daily", "2026-06-04T00:00:00.000Z", "2026-06-04T08:00:00.000Z"),
    ];
    expect(pickLatestByWindow(recaps, "daily")?.id).toBe("today");
  });

  it("breaks ties on the same window by generatedAt DESC", () => {
    const recaps = [
      row("old", "daily", "2026-06-04T00:00:00.000Z", "2026-06-04T08:00:00.000Z"),
      row("new", "daily", "2026-06-04T00:00:00.000Z", "2026-06-04T09:00:00.000Z"),
    ];
    expect(pickLatestByWindow(recaps, "daily")?.id).toBe("new");
  });

  it("skips superseded rows", () => {
    const recaps = [
      row("dead", "daily", "2026-06-04T00:00:00.000Z", "2026-06-04T09:00:00.000Z", "superseded"),
      row("live", "daily", "2026-06-03T00:00:00.000Z", "2026-06-03T09:00:00.000Z"),
    ];
    expect(pickLatestByWindow(recaps, "daily")?.id).toBe("live");
  });

  it("filters by period when one is given, and ignores it when not", () => {
    const recaps = [
      row("w", "weekly", "2026-06-01T00:00:00.000Z", "2026-06-01T09:00:00.000Z"),
      row("d", "daily", "2026-06-03T00:00:00.000Z", "2026-06-03T09:00:00.000Z"),
    ];
    expect(pickLatestByWindow(recaps, "weekly")?.id).toBe("w");
    expect(pickLatestByWindow(recaps)?.id).toBe("d");
  });

  it("returns null when nothing qualifies", () => {
    expect(pickLatestByWindow([], "daily")).toBeNull();
  });
});

describe("formatPeriod", () => {
  it("labels a daily window with its single UTC day", () => {
    expect(
      formatPeriod({
        period: "daily",
        periodStart: "2026-06-03T00:00:00.000Z",
        periodEnd: "2026-06-04T00:00:00.000Z",
      }),
    ).toBe("Wed, 03 Jun 2026");
  });

  it("labels a weekly window with its last day, not its exclusive end", () => {
    expect(
      formatPeriod({
        period: "weekly",
        periodStart: "2026-06-01T00:00:00.000Z",
        periodEnd: "2026-06-08T00:00:00.000Z",
      }),
    ).toBe("01 Jun → 07 Jun UTC");
  });
});
