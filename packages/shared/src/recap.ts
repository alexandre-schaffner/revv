import type { Activity } from "./activity";

export type RecapPeriod = "daily" | "weekly";

export type ProjectRecapStatus = "generating" | "complete" | "error" | "superseded";

/**
 * Pre-aggregated summary stats for the recap, computed alongside the
 * overview by the agent's `commit_recap_overview` MCP tool. The UI uses these
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

/**
 * Structured per-PR row inside a recap. Written by the agent via
 * `add_pr_entry` (idempotent upsert on `(recapId, prId)`); see
 * `db/schema/recap-pr-entries.ts` for the storage shape.
 *
 * `theme` is an open-vocabulary lowercase label — the UI maps it
 * deterministically to a swatch via hash and orders chapters by count desc.
 * `description` may contain backtick-wrapped code spans; nothing else. `tight`
 * is reserved for a future dense view.
 */
export interface RecapPrEntry {
  readonly id: string;
  readonly recapId: string;
  readonly prId: string;
  readonly position: number;
  readonly theme: string;
  readonly verb: string;
  /** Denormalized PR title at recap time. Falls back to "(PR removed)". */
  readonly prTitle: string;
  /** Denormalized GitHub PR number at recap time. */
  readonly prExternalId: number;
  /** Denormalized author github login at recap time. */
  readonly prAuthorLogin: string;
  /**
   * Base64 data URL of the author's avatar, joined from `remote_users` at read
   * time. Not persisted on the entry row. Null when no avatar has been synced
   * for this login yet — the UI falls back to an initials swatch.
   */
  readonly prAuthorAvatar: string | null;
  readonly description: string;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /**
   * Whether the PR was already archived (merged/closed) at recap time or still
   * open. Server-derived from which list the `pr_id` appeared in
   * (`sourceBundle.prs` vs `sourceBundle.openPrs`) — agents never set this
   * directly. The UI renders open entries as an "In progress" subgroup inside
   * the theme chapter, alongside the merged entries.
   */
  readonly prState: "merged" | "open";
}

/**
 * Short editorial paragraph (1–2 sentences) introducing the work that landed
 * in a single theme. Written by the agent via the `set_theme_summary` MCP
 * tool, idempotent upsert on `(recapId, theme)`. Themes without a summary
 * row still render — the UI only adds the lede when one is present.
 */
export interface RecapThemeSummary {
  readonly id: string;
  readonly recapId: string;
  /** Lowercase theme label matching `RecapPrEntry.theme` for the same recap. */
  readonly theme: string;
  /** 1–2 sentence summary. May contain backtick-wrapped code spans. */
  readonly summary: string;
}

export interface ProjectRecap {
  readonly id: string;
  readonly repositoryId: string;
  readonly period: RecapPeriod;
  readonly periodStart: string;
  readonly periodEnd: string;
  /**
   * Short editorial lede (1–3 sentences). May contain `<strong>` / `<em>`
   * tags only — everything else is stripped at render.
   */
  readonly lede: string;
  /** Sum of `entries[].linesAdded`. Stamped by `complete_recap`. */
  readonly totalLinesAdded: number;
  /** Sum of `entries[].linesRemoved`. */
  readonly totalLinesRemoved: number;
  /**
   * Structured per-PR entries, ordered by `position`. Populated by joining
   * `recap_pr_entries` on read.
   */
  readonly entries: ReadonlyArray<RecapPrEntry>;
  /**
   * Per-theme summary paragraphs. Each row binds a `theme` label (matching
   * one of the `entries[].theme` values) to a 1–2 sentence editorial blurb
   * that frames the chapter. Populated by joining `recap_theme_summaries`
   * on read. May be empty when the agent skipped summaries or hasn't reached
   * that step yet.
   */
  readonly themeSummaries: ReadonlyArray<RecapThemeSummary>;
  readonly status: ProjectRecapStatus;
  readonly supersededBy: string | null;
  readonly generatedAt: string;
  readonly completedAt: string | null;
  readonly modelUsed: string | null;
  readonly sourcePrIds: ReadonlyArray<string>;
  readonly sourceWalkthroughIds: ReadonlyArray<string>;
  readonly summaryStats: RecapSummaryStats;
  /** Human-readable failure reason when `status='error'`. Null otherwise. */
  readonly errorMessage: string | null;
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
  /** Human-readable failure reason when `status='error'`. Null otherwise. */
  readonly errorMessage: string | null;
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

// ── SSE stream events ───────────────────────────────────────────────────────

export type RecapStreamPhase =
  | "analyzing"
  | "writing_lede"
  | "categorizing"
  | "finalizing"
  | "connecting"
  | "other";

export type RecapStreamEvent =
  | { type: "thought"; data: { text: string } }
  | { type: "phase"; data: { phase: RecapStreamPhase; message: string } }
  | { type: "activity"; data: Activity }
  | { type: "lede"; data: { lede: string } }
  | { type: "entry"; data: { entry: RecapPrEntry } }
  | { type: "theme_summary"; data: { summary: RecapThemeSummary } }
  | { type: "done"; data: { recapId: string } }
  | { type: "error"; data: { code: string; message: string } };
