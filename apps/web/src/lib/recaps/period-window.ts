import { fullWindow, type RecapPeriod, startOfUtcIsoWeek, windowIsCurrent } from "@revv/shared";

/**
 * UTC date arithmetic and labels for the recap calendar and staleness checks.
 * Which window is open and what a closed one spans come from `@revv/shared`
 * (`recap-period.ts`), which the server uses too.
 *
 * Two traps this module exists to contain:
 *
 *  1. `new Date("2026-06-03")` parses as **UTC midnight**, but
 *     `new Date("2026-06-03T00:00:00")` parses as **local midnight**. Never
 *     concatenate a bare time onto a day key — build instants with
 *     `Date.UTC(...)` or an explicit `Z`.
 *  2. Month/day arithmetic goes through `Date.UTC(y, m, d + n)`, which
 *     normalises under- and overflow for free (day 0 = last day of the
 *     previous month, month 12 = January of the next year). Hand-rolled
 *     modulo arithmetic on month numbers is how you ship a Dec→Jan bug.
 *
 * Everything here is a UTC *day key* (`"YYYY-MM-DD"`) or *month key*
 * (`"YYYY-MM"`); both sort chronologically as plain strings.
 */

/**
 * Compare through {@link utcDayKey}: a raw `Date < string` comparison
 * type-checks and silently misbehaves.
 */
export interface RecapWindow {
  period: RecapPeriod;
  periodStart: string | Date;
  periodEnd: string | Date;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export function utcDayKey(value: string | Date): string {
  const s = typeof value === "string" ? value : value.toISOString();
  return s.slice(0, 10);
}

export function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcMondayKey(d: Date): string {
  return utcDateKey(startOfUtcIsoWeek(d));
}

/** The safe way to turn a day key into a Date: see trap 1 in the module doc. */
export function dayKeyToUtcDate(key: string): Date {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const day = Number(key.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day));
}

export function addUtcDays(key: string, n: number): string {
  const d = dayKeyToUtcDate(key);
  return utcDateKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n)));
}

export function monthKeyOf(value: string | Date): string {
  return utcDayKey(value).slice(0, 7);
}

export function shiftMonth(monthKey: string, delta: number): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return utcDateKey(d).slice(0, 7);
}

export function mondayKeyOf(dayKey: string): string {
  return utcMondayKey(dayKeyToUtcDate(dayKey));
}

/**
 * Always six rows, even when five would cover the month, so the calendar
 * never changes height between months. `fromKey` / `toKeyExclusive` bound the
 * whole grid, including the neighbouring months' leading and trailing days.
 */
export function monthGrid(monthKey: string): {
  weeks: string[][];
  fromKey: string;
  toKeyExclusive: string;
} {
  const firstOfMonth = `${monthKey}-01`;
  const fromKey = mondayKeyOf(firstOfMonth);
  const weeks: string[][] = [];
  for (let row = 0; row < 6; row++) {
    const week: string[] = [];
    for (let col = 0; col < 7; col++) {
      week.push(addUtcDays(fromKey, row * 7 + col));
    }
    weeks.push(week);
  }
  return { weeks, fromKey, toKeyExclusive: addUtcDays(fromKey, 42) };
}

/**
 * Spans the grid, not the calendar month, so a weekly recap whose Monday sits
 * in the previous month still fills the grid's first row.
 */
export function monthGridRange(monthKey: string): { from: string; to: string } {
  const { fromKey, toKeyExclusive } = monthGrid(monthKey);
  return {
    from: dayKeyToUtcDate(fromKey).toISOString(),
    to: dayKeyToUtcDate(toKeyExclusive).toISOString(),
  };
}

export function recapSlotKey(r: RecapWindow): string {
  return `${r.period}:${utcDayKey(r.periodStart)}`;
}

export function slotKeyFor(period: RecapPeriod, anchorDayKey: string): string {
  return period === "daily" ? `daily:${anchorDayKey}` : `weekly:${mondayKeyOf(anchorDayKey)}`;
}

export function isCurrentPeriod(
  period: RecapPeriod,
  dayKey: string,
  now: Date = new Date(),
): boolean {
  return windowIsCurrent(period, dayKeyToUtcDate(dayKey), now);
}

/**
 * Boundaries to send with a generate request, or `null` for the current
 * period: omit `periodStart`/`periodEnd` and let the server roll its own
 * window. A past window is closed and immutable, so re-clicking returns the
 * existing recap; pinning today's moving window would freeze the recap at its
 * first generation and make regeneration a silent no-op.
 */
export function selectionBoundaries(
  period: RecapPeriod,
  dayKey: string,
  now: Date = new Date(),
): { periodStart: string; periodEnd: string } | null {
  if (isCurrentPeriod(period, dayKey, now)) return null;
  return fullWindow(period, dayKeyToUtcDate(dayKey));
}

function isClosedFullPeriod(r: RecapWindow): boolean {
  const start = new Date(r.periodStart).getTime();
  const end = new Date(r.periodEnd).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return end - start === (r.period === "daily" ? DAY_MS : WEEK_MS);
}

/**
 * Status-independent on purpose: a stopped or errored recap from last week is
 * just as stale as a completed one, and both deserve a fresh-period CTA.
 */
export function recapWindowIsStale(r: RecapWindow): boolean {
  if (isClosedFullPeriod(r)) return true;
  return !isCurrentPeriod(r.period, utcDayKey(r.periodStart));
}

/**
 * The recap covering the latest *window*, not the latest generation: a recap
 * generated today for three weeks ago must not hijack the "Daily recap" hero
 * and the repo home card. A regenerate of the same window still wins.
 */
export function pickLatestByWindow<T extends RecapWindow & { status: string; generatedAt: string }>(
  recaps: readonly T[],
  period?: RecapPeriod,
): T | null {
  let best: T | null = null;
  for (const r of recaps) {
    if (r.status === "superseded") continue;
    if (period !== undefined && r.period !== period) continue;
    if (best === null) {
      best = r;
      continue;
    }
    const a = utcDayKey(r.periodStart);
    const b = utcDayKey(best.periodStart);
    if (a > b || (a === b && r.generatedAt > best.generatedAt)) best = r;
  }
  return best;
}

const DAY_MONTH_YEAR_FMT = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const DAY_MONTH_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});

export interface RecapSpan {
  readonly period: RecapPeriod;
  readonly first: Date;
  readonly last: Date;
}

/** `periodEnd` is exclusive. */
export function recapSpan(r: RecapWindow): RecapSpan {
  return {
    period: r.period,
    first: new Date(r.periodStart),
    last: new Date(new Date(r.periodEnd).getTime() - 1),
  };
}

export function slotSpan(period: RecapPeriod, dayKey: string): RecapSpan {
  if (period === "daily") {
    const day = dayKeyToUtcDate(dayKey);
    return { period, first: day, last: day };
  }
  const monday = mondayKeyOf(dayKey);
  return {
    period,
    first: dayKeyToUtcDate(monday),
    last: dayKeyToUtcDate(addUtcDays(monday, 6)),
  };
}

export function openSpan(period: RecapPeriod, now: Date = new Date()): RecapSpan {
  return { period, first: period === "daily" ? now : startOfUtcIsoWeek(now), last: now };
}

/** Heading for a recap: `"Wed, 03 Jun 2026"`, or `"Week of 01 Jun – 07 Jun"`. */
export function formatRecapTitle(span: RecapSpan): string {
  if (span.period === "daily") return DAY_MONTH_YEAR_FMT.format(span.first);
  return `Week of ${DAY_MONTH_FMT.format(span.first)} – ${DAY_MONTH_FMT.format(span.last)}`;
}

/** Compact label for a recap: `"Wed, 03 Jun 2026"`, or `"01 Jun → 07 Jun"`. */
export function formatRecapRange(span: RecapSpan): string {
  if (span.period === "daily") return DAY_MONTH_YEAR_FMT.format(span.first);
  return `${DAY_MONTH_FMT.format(span.first)} → ${DAY_MONTH_FMT.format(span.last)}`;
}

/**
 * Route for a calendar slot, whether or not a recap exists for it yet: the
 * empty "generate one?" page is what makes every grid cell clickable.
 */
export function windowPath(repoId: string, period: RecapPeriod, dayKey: string): string {
  const anchor = period === "daily" ? dayKey : mondayKeyOf(dayKey);
  return `/repo/${repoId}/recaps/${period}/${anchor}`;
}
