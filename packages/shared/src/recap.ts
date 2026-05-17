// ── Project Recap shared types ───────────────────────────────────────────────
//
// Daily / weekly recap of recently-archived PRs in a repository. Wire shape
// matches the server's `project_recaps` row (see db/schema/project-recaps.ts).
// See plan: /Users/alex/.claude/plans/let-s-review-the-archive-logical-eagle.md

export type RecapPeriod = "daily" | "weekly";

export type ProjectRecapStatus = "generating" | "complete" | "error" | "superseded";

/**
 * Pre-aggregated summary stats for the recap, computed alongside the
 * overview by the agent's `set_recap_overview` MCP tool. The UI uses these
 * to render the recap list-item header without re-aggregating; the agent
 * also embeds them in the overview markdown for narrative purposes.
 */
export interface RecapSummaryStats {
  /** Total archived PRs in the period (mergedCount + closedCount). */
  readonly prCount: number;
  readonly mergedCount: number;
  readonly closedCount: number;
  /** Distinct author logins across the period. */
  readonly authorCount: number;
  /** Walkthrough risk-level distribution. PRs without walkthroughs are not counted. */
  readonly riskBreakdown: {
    readonly low: number;
    readonly medium: number;
    readonly high: number;
  };
  /**
   * Count of source PRs that had no completed walkthrough at recap time.
   * Surfaced in the UI as the "regenerate to incorporate N late walkthroughs"
   * affordance. Computed by `listArchivedPrsForWindow` at recap generation.
   */
  readonly walkthroughsMissingCount: number;
}

export interface ProjectRecap {
  readonly id: string;
  readonly repositoryId: string;
  readonly period: RecapPeriod;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly overview: string;
  readonly status: ProjectRecapStatus;
  readonly supersededBy: string | null;
  readonly generatedAt: string;
  readonly completedAt: string | null;
  readonly modelUsed: string | null;
  readonly sourcePrIds: ReadonlyArray<string>;
  readonly sourceWalkthroughIds: ReadonlyArray<string>;
  readonly summaryStats: RecapSummaryStats;
}

/**
 * Lightweight projection of a recap suitable for the UI's list view: drops
 * the full overview markdown to keep payloads small. The detail view fetches
 * the full ProjectRecap via `GET /api/recaps/:id`.
 */
export interface ProjectRecapSummary {
  readonly id: string;
  readonly repositoryId: string;
  readonly period: RecapPeriod;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: ProjectRecapStatus;
  readonly generatedAt: string;
  readonly completedAt: string | null;
  readonly sourcePrCount: number;
  readonly summaryStats: RecapSummaryStats;
}

/** Default stats object when the agent hasn't written any yet. */
export const EMPTY_RECAP_STATS: RecapSummaryStats = {
  prCount: 0,
  mergedCount: 0,
  closedCount: 0,
  authorCount: 0,
  riskBreakdown: { low: 0, medium: 0, high: 0 },
  walkthroughsMissingCount: 0,
};
