// A recap covers one UTC day or one ISO week (Monday first). The server picks
// windows to generate and the web picks the window a calendar cell asks for;
// both use these, so a cell and the row it requests can't disagree.

import type { RecapPeriod } from "./recap";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RecapWindowBounds {
  /** Inclusive, ISO 8601 UTC. */
  readonly periodStart: string;
  /** Exclusive, ISO 8601 UTC. */
  readonly periodEnd: string;
}

export function startOfUtcDay(d: Date): Date {
  const out = new Date(d.getTime());
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

/** The Monday that starts `d`'s ISO week; Sunday belongs to the week before. */
export function startOfUtcIsoWeek(d: Date): Date {
  const day = startOfUtcDay(d);
  const daysFromMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - daysFromMonday * DAY_MS);
}

function startOfPeriod(period: RecapPeriod, d: Date): Date {
  return period === "daily" ? startOfUtcDay(d) : startOfUtcIsoWeek(d);
}

function periodSpanMs(period: RecapPeriod): number {
  return period === "daily" ? DAY_MS : 7 * DAY_MS;
}

/** The window that starts at `periodStart` is still open: today, or this ISO week. */
export function windowIsCurrent(
  period: RecapPeriod,
  periodStart: string | Date,
  now: Date = new Date(),
): boolean {
  return (
    startOfPeriod(period, new Date(periodStart)).getTime() === startOfPeriod(period, now).getTime()
  );
}

/** The whole day or week containing `at`. */
export function fullWindow(period: RecapPeriod, at: string | Date): RecapWindowBounds {
  const start = startOfPeriod(period, new Date(at));
  return {
    periodStart: start.toISOString(),
    periodEnd: new Date(start.getTime() + periodSpanMs(period)).toISOString(),
  };
}

/** The open window so far: today or this week, up to `now`. */
export function rollingWindow(period: RecapPeriod, now: Date = new Date()): RecapWindowBounds {
  return { periodStart: startOfPeriod(period, now).toISOString(), periodEnd: now.toISOString() };
}

/**
 * The window a recap starting at `periodStart` covers when (re)generated now:
 * rolling up to `now` while it is still open, the whole period once closed.
 */
export function canonicalWindow(
  period: RecapPeriod,
  periodStart: string | Date,
  now: Date = new Date(),
): RecapWindowBounds {
  return windowIsCurrent(period, periodStart, now)
    ? rollingWindow(period, now)
    : fullWindow(period, periodStart);
}

/** The last `count` closed windows, newest first: yesterday backwards, or last week backwards. */
export function closedWindows(period: RecapPeriod, now: Date, count: number): RecapWindowBounds[] {
  const span = periodSpanMs(period);
  const currentStart = startOfPeriod(period, now).getTime();
  return Array.from({ length: count }, (_, i) =>
    fullWindow(period, new Date(currentStart - (i + 1) * span)),
  );
}

/** The window closed most recently: yesterday, or last week. */
export function isLatestClosedWindow(
  period: RecapPeriod,
  window: RecapWindowBounds,
  now: Date = new Date(),
): boolean {
  return new Date(window.periodEnd).getTime() === startOfPeriod(period, now).getTime();
}
