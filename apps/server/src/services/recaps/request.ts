import {
  isLatestClosedWindow,
  type ProjectRecapStatus,
  type RecapPeriod,
  type RecapWindowBounds,
} from "@revv/shared";

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
 * - `manual` reruns the open window and failed/stopped rows. A complete
 *   pinned closed window is reused.
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
  readonly existing: { readonly generatedAt: string; readonly status?: ProjectRecapStatus } | null;
  readonly now: Date;
}): RecapRequestPlan {
  const { existing } = input;
  if (existing === null) return "create";
  switch (input.intent) {
    case "regenerate":
      return "rerun";
    case "manual":
      return input.rolling || existing.status === "error" || existing.status === "stopped"
        ? "rerun"
        : "reuse";
    case "scheduled":
      // A terminal job exhausted its automatic budget or was explicitly stopped.
      // Only a user request may reset that budget.
      if (existing.status === "error" || existing.status === "stopped") return "reuse";
      return isLatestClosedWindow(input.period, input.window, input.now) &&
        new Date(existing.generatedAt).getTime() < new Date(input.window.periodEnd).getTime()
        ? "rerun"
        : "reuse";
  }
}
