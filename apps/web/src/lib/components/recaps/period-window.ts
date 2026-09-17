import type { RecapPeriod } from "@revv/shared";

/**
 * Pure UTC date arithmetic for the recap calendar and the "is this recap
 * stale?" checks. No imports beyond the shared `RecapPeriod` type on purpose —
 * this file is unit-tested in isolation and must stay free of Svelte, stores
 * and the network.
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
 * Everything here is a UTC *day key* — `"YYYY-MM-DD"` — or a *month key* —
 * `"YYYY-MM"`. Both sort lexicographically in chronological order, which is
 * what lets the comparisons below be plain string comparisons.
 */

/**
 * Minimal shape needed to reason about a recap's time window. Dates arrive as
 * ISO strings over SSE and as `Date` after an Eden fetch, so both are accepted.
 * Every helper that takes one keeps the union and funnels through
 * {@link utcDayKey} — a raw `Date < string` comparison type-checks and
 * silently misbehaves.
 */
export interface RecapWindow {
  period: RecapPeriod;
  periodStart: string | Date;
  periodEnd: string | Date;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/** UTC day key of an ISO string or Date, whichever the wire handed us. */
export function utcDayKey(value: string | Date): string {
  const s = typeof value === "string" ? value : value.toISOString();
  return s.slice(0, 10);
}

/** UTC day key of a Date. */
export function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Day key of the Monday on-or-before the given Date (ISO weeks start Monday). */
export function utcMondayKey(d: Date): string {
  const daysFromMonday = (d.getUTCDay() + 6) % 7;
  const mondayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysFromMonday);
  return new Date(mondayMs).toISOString().slice(0, 10);
}

/**
 * UTC midnight for a day key. The one safe way to turn `"2026-06-03"` into a
 * Date — see trap 1 in the module doc.
 */
export function dayKeyToUtcDate(key: string): Date {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const day = Number(key.slice(8, 10));
  return new Date(Date.UTC(year, month - 1, day));
}

/** Day key `n` days after `key` (negative `n` goes backwards). */
export function addUtcDays(key: string, n: number): string {
  const d = dayKeyToUtcDate(key);
  return utcDateKey(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n)));
}

/** Month key (`"2026-06"`) of a day key, ISO instant or Date. */
export function monthKeyOf(value: string | Date): string {
  return utcDayKey(value).slice(0, 7);
}

/** Month key `delta` months after `monthKey`. Rolls across years. */
export function shiftMonth(monthKey: string, delta: number): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return utcDateKey(d).slice(0, 7);
}

/** String-in/string-out sibling of {@link utcMondayKey}. */
export function mondayKeyOf(dayKey: string): string {
  return utcMondayKey(dayKeyToUtcDate(dayKey));
}

/**
 * 6×7 Monday-first day keys starting from the Monday on-or-before the 1st of
 * `monthKey`. Always six rows, even when five would cover the month, so the
 * grid never changes height between months.
 *
 * `fromKey` / `toKeyExclusive` bound the whole grid, not the calendar month —
 * the leading and trailing days belong to the neighbouring months.
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
 * ISO instants bounding the list query for a month's grid. Spans the *grid*,
 * not the calendar month, so a weekly row whose Monday sits in the previous
 * month is included — otherwise the first row of the grid would render as
 * empty in weekly mode even when a recap exists for it.
 */
export function monthGridRange(monthKey: string): { from: string; to: string } {
  const { fromKey, toKeyExclusive } = monthGrid(monthKey);
  return {
    from: dayKeyToUtcDate(fromKey).toISOString(),
    to: dayKeyToUtcDate(toKeyExclusive).toISOString(),
  };
}

/** Calendar slot a recap occupies: `"daily:2026-06-03"` / `"weekly:2026-06-01"`. */
export function recapSlotKey(r: RecapWindow): string {
  return `${r.period}:${utcDayKey(r.periodStart)}`;
}

/** Slot key for a cell. `anchorDayKey` is the cell's own day; weekly snaps to its Monday. */
export function slotKeyFor(period: RecapPeriod, anchorDayKey: string): string {
  return period === "daily" ? `daily:${anchorDayKey}` : `weekly:${mondayKeyOf(anchorDayKey)}`;
}

/**
 * True when `dayKey` falls in the period that is still open right now — today
 * for daily, the current ISO week for weekly.
 *
 * Mirror of the server's `windowIsCurrent` (`RecapScheduler.ts`). Same
 * semantics on two sides of the wire; keep the two in step.
 */
export function isCurrentPeriod(
  period: RecapPeriod,
  dayKey: string,
  now: Date = new Date(),
): boolean {
  return period === "daily"
    ? dayKey === utcDateKey(now)
    : mondayKeyOf(dayKey) === utcMondayKey(now);
}

/**
 * Boundaries to send with a generate request for the slot anchored at
 * `dayKey`, or `null` for the *current* period.
 *
 * `null` is the signal to omit `periodStart`/`periodEnd` entirely and let the
 * server roll its own window. That branch is not cosmetic: a past window is
 * closed and immutable, so pinning it is right and re-clicking should return
 * the existing recap; today's window moves every second, so pinning it would
 * freeze the recap at its first generation and make regeneration a silent
 * no-op.
 *
 * Mirrors the server's `canonicalRecapBoundaries` (`RecapScheduler.ts`) for
 * the closed-window case — daily `[dayKey T00:00Z, +1d)`, weekly
 * `[mondayKeyOf(dayKey) T00:00Z, +7d)`. Keep the two textually parallel.
 */
export function selectionBoundaries(
  period: RecapPeriod,
  dayKey: string,
  now: Date = new Date(),
): { periodStart: string; periodEnd: string } | null {
  if (isCurrentPeriod(period, dayKey, now)) return null;
  const startKey = period === "daily" ? dayKey : mondayKeyOf(dayKey);
  const endKey = addUtcDays(startKey, period === "daily" ? 1 : 7);
  return {
    periodStart: dayKeyToUtcDate(startKey).toISOString(),
    periodEnd: dayKeyToUtcDate(endKey).toISOString(),
  };
}

/** A recap whose window spans a whole closed day/week rather than "so far". */
function isClosedFullPeriod(r: RecapWindow): boolean {
  const start = new Date(r.periodStart).getTime();
  const end = new Date(r.periodEnd).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return end - start === (r.period === "daily" ? DAY_MS : WEEK_MS);
}

/**
 * True when the recap doesn't cover the current UTC day/week — either because
 * it's a closed full period, or because its start is in an earlier window.
 * Status-independent on purpose: a stopped or errored recap from last week is
 * just as stale as a completed one, and both deserve a fresh-period CTA.
 */
export function recapWindowIsStale(r: RecapWindow): boolean {
  if (isClosedFullPeriod(r)) return true;
  return !isCurrentPeriod(r.period, utcDayKey(r.periodStart));
}

/**
 * The recap covering the latest *window*, not the latest generation.
 *
 * `generatedAt DESC` — the order the store keeps the list in — is the wrong
 * pick for a hero: generate a recap for three weeks ago today and it becomes
 * the newest row, hijacking the "Daily recap" hero and the repo home card.
 * Max by `periodStart`, tie-broken by `generatedAt` DESC so a regenerate of
 * the same window still wins.
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

/**
 * Human label for a recap's window: `"Fri 03 Jun 2026"` for daily,
 * `"01 Jun → 07 Jun UTC"` for weekly. Weekly shows the window's *last day*,
 * not its exclusive end.
 */
export function formatPeriod(r: RecapWindow): string {
  const start = new Date(r.periodStart);
  if (r.period === "daily") return DAY_MONTH_YEAR_FMT.format(start);
  const lastDay = new Date(new Date(r.periodEnd).getTime() - 1);
  return `${DAY_MONTH_FMT.format(start)} → ${DAY_MONTH_FMT.format(lastDay)} UTC`;
}

/** Human label for a calendar slot that has no recap yet. */
export function formatSlot(period: RecapPeriod, dayKey: string): string {
  if (period === "daily") return DAY_MONTH_YEAR_FMT.format(dayKeyToUtcDate(dayKey));
  const monday = mondayKeyOf(dayKey);
  const sunday = addUtcDays(monday, 6);
  return `${DAY_MONTH_FMT.format(dayKeyToUtcDate(monday))} → ${DAY_MONTH_FMT.format(dayKeyToUtcDate(sunday))} UTC`;
}
