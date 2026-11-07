import type { Activity } from "./activity";
import type { StreamErrorCode } from "./stream-frames";

export const RECAP_PERIODS = ["daily", "weekly"] as const;
export type RecapPeriod = (typeof RECAP_PERIODS)[number];

/**
 * The most summaries one `GET /repos/:id/recaps` page holds. A calendar
 * month's 6×7 grid (up to 42 daily + 6 weekly) fits in one page at this size.
 */
export const MAX_RECAP_PAGE_LIMIT = 100;

/**
 * `stopped`: the user stopped generation. Unlike `error`, nothing went wrong,
 * so the UI offers to resume rather than reporting a failure.
 */
export type ProjectRecapStatus = "generating" | "complete" | "error" | "stopped" | "superseded";

/** Derived from the recap's source PRs by the server, never written by the agent. */
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
  /** Source PRs that had no completed walkthrough at recap time. */
  readonly walkthroughsMissingCount: number;
}

/**
 * Written by the agent via `add_pr_entry`, keyed on `(recapId, prId)`.
 *
 * `theme` is an open-vocabulary lowercase label — the UI maps it
 * deterministically to a swatch via hash and orders chapters by count desc.
 * `description` may contain backtick-wrapped code spans; nothing else.
 */
export interface RecapPrEntry {
  readonly id: string;
  readonly recapId: string;
  readonly prId: string;
  readonly position: number;
  readonly theme: string;
  readonly verb: string;
  /** Denormalized PR title at recap time. */
  readonly prTitle: string;
  /** Denormalized GitHub PR number at recap time. */
  readonly prExternalId: number;
  /** Denormalized author github login at recap time. */
  readonly prAuthorLogin: string;
  /**
   * Base64 data URL joined from `remote_users` at read time, not persisted on
   * the entry. Null when no avatar has been synced for this login yet.
   */
  readonly prAuthorAvatar: string | null;
  readonly description: string;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /**
   * Whether the PR was already archived (merged/closed) at recap time or still
   * open. Server-derived from the source bundle; agents never set it.
   */
  readonly prState: "merged" | "open";
}

/**
 * Written by the agent via `set_theme_summary`, keyed on `(recapId, theme)`.
 * Optional per theme: a theme without one still renders.
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
  /** Sum of `entries[].linesAdded`, computed on read. */
  readonly totalLinesAdded: number;
  /** Sum of `entries[].linesRemoved`. */
  readonly totalLinesRemoved: number;
  /** Ordered by `position`. */
  readonly entries: ReadonlyArray<RecapPrEntry>;
  /** May be empty: the agent can skip summaries or not have reached them yet. */
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

/** List-view projection; the full ProjectRecap comes from `GET /api/recaps/:id`. */
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

export function recapSummaryOf(recap: ProjectRecap): ProjectRecapSummary {
  return {
    id: recap.id,
    repositoryId: recap.repositoryId,
    period: recap.period,
    periodStart: recap.periodStart,
    periodEnd: recap.periodEnd,
    status: recap.status,
    generatedAt: recap.generatedAt,
    completedAt: recap.completedAt,
    sourcePrCount: recap.sourcePrIds.length,
    summaryStats: recap.summaryStats,
    errorMessage: recap.errorMessage,
  };
}

/**
 * Lede for a *historical* window with no activity at all — no PR closed in
 * it, none in flight across it. The orchestrator completes the row with this
 * text without invoking the agent, so a quiet weekend renders as a finished
 * recap rather than a failure. A live window (today / this week) with nothing
 * in it still errors: "nothing has happened yet" is the honest answer there.
 */
export const RECAP_EMPTY_WINDOW_LEDE =
  "Nothing shipped in this window — no pull requests closed, and none were in flight.";

export const EMPTY_RECAP_STATS: RecapSummaryStats = {
  prCount: 0,
  mergedCount: 0,
  closedCount: 0,
  authorCount: 0,
  riskBreakdown: { low: 0, medium: 0, high: 0 },
  walkthroughsMissingCount: 0,
};

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
  | { type: "stopped"; data: { recapId: string } }
  /** A rerun replaced this run, under the same id: the stream ends; attach again for the new one. */
  | { type: "restarted"; data: { recapId: string } }
  /** The recap failed (`GENERATION_ERROR`), or a newer one replaced it (`STALE`). */
  | { type: "error"; data: { code: StreamErrorCode; message: string } };
