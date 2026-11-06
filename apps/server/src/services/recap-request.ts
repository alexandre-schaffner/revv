import { isLatestClosedWindow, type RecapPeriod, type RecapWindowBounds } from "@revv/shared";

/**
 * Why a recap is being asked for. `scheduled`: the scheduler's sweep over
 * closed windows. `manual`: the user asked for a window. `regenerate`: the
 * user asked to rewrite one.
 */
export type RecapIntent = "scheduled" | "manual" | "regenerate";

/** `create` a row, `reuse` the window's row as it is, or `rerun` it in place. */
export type RecapRequestPlan = "create" | "reuse" | "rerun";

/**
 * The one recap-reuse policy. A window holds at most one active recap, so a
 * request either creates it or decides what to do with the one there:
 *
 * - `regenerate` always reruns.
 * - `manual` reruns the open window (it has moved on since) and reuses a
 *   pinned closed one, whose answer can't change.
 * - `scheduled` reruns a recap of the most recently closed window that was
 *   written before the window closed, so it caught only part of it; anything
 *   else stands.
 */
export function planRecapRequest(input: {
  readonly intent: RecapIntent;
  readonly period: RecapPeriod;
  readonly window: RecapWindowBounds;
  /** The window is the open one, up to now, rather than a pinned one. */
  readonly rolling: boolean;
  readonly existing: { readonly generatedAt: string } | null;
  readonly now: Date;
}): RecapRequestPlan {
  const { existing } = input;
  if (existing === null) return "create";
  switch (input.intent) {
    case "regenerate":
      return "rerun";
    case "manual":
      return input.rolling ? "rerun" : "reuse";
    case "scheduled":
      return isLatestClosedWindow(input.period, input.window, input.now) &&
        new Date(existing.generatedAt).getTime() < new Date(input.window.periodEnd).getTime()
        ? "rerun"
        : "reuse";
  }
}
