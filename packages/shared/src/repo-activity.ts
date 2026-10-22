/** One week of activity. Weeks open on Sunday 00:00 UTC, as GitHub counts them. */
export interface RepoActivityWeek {
  /** The week's Sunday as `YYYY-MM-DD` (UTC). */
  weekStart: string;
  /** Commits per day, Sunday first. Always seven entries. */
  days: number[];
  /** Lines added that week, or null when GitHub won't compute code frequency. */
  additions: number | null;
  /** Lines deleted that week (a positive count), null alongside `additions`. */
  deletions: number | null;
}

/**
 * `computing` is GitHub's 202: the statistics aren't cached on its side yet
 * and a later request will have them. It is never cached by the server.
 */
export type RepoActivity =
  | { status: "computing" }
  | {
      status: "ready";
      /** Oldest first, the current week last. */
      weeks: RepoActivityWeek[];
      fetchedAt: string;
    };

export interface RepoPrFlow {
  mergedLast7d: number;
  mergedPrev7d: number;
  openedLast7d: number;
  openedPrev7d: number;
  /** Median hours from open to merge over PRs merged in the last 28 days; null with none. */
  medianHoursToMerge: number | null;
  /** How many merges the median was taken over: all of them, or the newest 100. */
  medianSample: number;
  mergedLast28d: number;
  /** Distinct authors of PRs merged in the last 28 days. */
  authorsLast28d: number;
  /** PRs merged per week over the last four weeks, oldest first. */
  mergedPerWeek: number[];
}

export interface RepoActivityResponse {
  commits: RepoActivity;
  /** Null when GitHub's search API couldn't be reached (rate limits, mostly). */
  flow: RepoPrFlow | null;
}
