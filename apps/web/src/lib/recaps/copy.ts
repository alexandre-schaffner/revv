import type { RecapPeriod } from "@revv/shared";

/** How the UI names a recap period. */
export interface RecapPeriodCopy {
  /** "Daily", for tabs. */
  readonly label: string;
  /** "daily", mid-sentence. */
  readonly adjective: string;
  /** "Daily recap", for eyebrows. */
  readonly title: string;
  /** "day": the window one recap covers. */
  readonly unit: string;
  /** "today's": the window still open. */
  readonly current: string;
}

export const RECAP_PERIOD_COPY: Record<RecapPeriod, RecapPeriodCopy> = {
  daily: {
    label: "Daily",
    adjective: "daily",
    title: "Daily recap",
    unit: "day",
    current: "today's",
  },
  weekly: {
    label: "Weekly",
    adjective: "weekly",
    title: "Weekly recap",
    unit: "week",
    current: "this week's",
  },
};
