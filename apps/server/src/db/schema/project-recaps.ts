import type { RecapPeriod, RecapSummaryStats } from "@revv/shared";
import { type AnySQLiteColumn, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { repositories } from "./repositories";

export interface RecapSourcePrDigest {
  readonly source: "cache" | "github" | "unavailable";
  readonly digest: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly status: string;
    readonly additions: number;
    readonly deletions: number;
    readonly patchAvailable: boolean;
    readonly patchTruncated: boolean;
  }>;
  readonly note: string | null;
}

export interface RecapSourcePr {
  readonly id: string;
  readonly externalId: number;
  readonly title: string;
  readonly authorLogin: string;
  readonly status: "closed" | "merged" | "open";
  readonly closedAt: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly url: string;
  /**
   * Body of the PR description, truncated if very long. Null if GitHub
   * never had one or it was empty.
   */
  readonly body: string | null;
  /**
   * The PR's latest non-superseded complete walkthrough, if any. Null when
   * no human ever generated a walkthrough or all of them are
   * superseded/error/generating. Recap agent should still include the PR
   * in the narrative — just without walkthrough-derived insight.
   */
  readonly walkthrough: {
    readonly id: string;
    readonly summary: string;
    readonly sentiment: string | null;
    readonly riskLevel: "low" | "medium" | "high";
    readonly completedAt: string | null;
  } | null;
  /** Compact pre-ingested diff context for PRs without walkthroughs. */
  readonly diffDigest: RecapSourcePrDigest | null;
}

export interface RecapSourceBundle {
  readonly repoId: string;
  readonly repoFullName: string;
  readonly period: RecapPeriod;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Archived (closed/merged) PRs in the period window. */
  readonly prs: ReadonlyArray<RecapSourcePr>;
  /** Currently open PRs with walkthrough context, sorted by relevancy. */
  readonly openPrs: ReadonlyArray<RecapSourcePr>;
  /** Pre-computed summary stats — same shape persisted on the recap row. */
  readonly stats: RecapSummaryStats;
}

/**
 * Daily / weekly recap of recently-archived PRs in a repository.
 *
 * Content is produced through a structured MCP-routed pipeline. The agent
 * writes (1) a short editorial `lede` via `set_lede`, then (2) one
 * `recap_pr_entries` row per included PR via `add_pr_entry` (idempotent upsert
 * keyed on `(recap_id, pr_id)`), then (3) `complete_recap` to finalize. The
 * orchestrator transitions `status` to `'complete'` only after `complete_recap`
 * validates non-empty lede + ≥1 entry row.
 *
 * Immutability: a recap is keyed on `(repositoryId, period, periodStart)`. On
 * regenerate, the existing row is marked `'superseded'` (with
 * `supersededBy` pointing at the replacement) and a fresh row is inserted —
 * mirroring the walkthrough supersession pattern so audit trails survive.
 *
 * A closed window with no PRs completes without an agent run; a window still
 * in progress with none fails, so the user comes back later.
 *
 * Period boundaries are ISO UTC strings, inclusive lower / exclusive upper.
 * There is no timezone column.
 */
export const projectRecaps = sqliteTable(
  "project_recaps",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** `'daily' | 'weekly'`. */
    period: text("period").notNull(),
    /** Inclusive lower bound on the period window (ISO 8601 UTC). */
    periodStart: text("period_start").notNull(),
    /** Exclusive upper bound on the period window (ISO 8601 UTC). */
    periodEnd: text("period_end").notNull(),
    /**
     * Short (1–3 sentences) model-written lede. May contain `<strong>` / `<em>`
     * tags only: the `set_lede` handler strips every other tag, and the UI
     * applies the same allowlist. `complete_recap` requires it non-empty.
     */
    lede: text("lede").notNull().default(""),
    /**
     * Orchestrator-only (CLAUDE.md invariant 11); agents never write it.
     *   `generating` — job running or resumable
     *   `complete`   — `complete_recap` validation passed
     *   `error`      — terminal failure (exceeded retries / unrecoverable)
     *   `stopped`    — the user stopped generation
     *   `superseded` — a regenerate produced a newer row (see `supersededBy`)
     */
    status: text("status").notNull().default("generating"),
    /**
     * Self-FK set when `status='superseded'`: points at the recap row that
     * replaces this one (always same `(repositoryId, period, periodStart)`).
     */
    supersededBy: text("superseded_by").references((): AnySQLiteColumn => projectRecaps.id, {
      onDelete: "set null",
    }),
    /** ISO 8601 timestamp at job start. */
    generatedAt: text("generated_at").notNull(),
    /** ISO 8601 timestamp at `status='complete'` transition. Null until then. */
    completedAt: text("completed_at"),
    /** Model identifier used to produce this recap (e.g. `claude-opus-4-8`). */
    modelUsed: text("model_used"),
    /** Token usage stats as JSON (input/output/cache). Best-effort — recap is fire-and-forget. */
    tokenUsage: text("token_usage").notNull().default("{}"),
    /** JSON `string[]` — the PR ids the agent included in this recap. */
    sourcePrIds: text("source_pr_ids").notNull().default("[]"),
    /** JSON `string[]` — the walkthrough ids the agent read. */
    sourceWalkthroughIds: text("source_walkthrough_ids").notNull().default("[]"),
    /**
     * JSON summary stats (`prCount`, `mergedCount`, `closedCount`,
     * `authorCount`, `riskBreakdown`). Pre-computed so the UI doesn't have
     * to re-aggregate at render time.
     */
    summaryStats: text("summary_stats").notNull().default("{}"),
    /**
     * Resume-on-boot counter, bounded by `MAX_RESUME_ATTEMPTS`
     * (`services/jobs/agent-jobs.ts`). A row past the cap goes to `'error'`.
     */
    resumeAttempts: integer("resume_attempts").notNull().default(0),
    /**
     * Why `status='error'`, shown to the user instead of a generic "Generation
     * failed." Orchestrator-written.
     */
    errorMessage: text("error_message"),
    /**
     * The window's pull requests and their digests as the first run assembled
     * them. A resumed run reads this rather than re-querying, so it sees the
     * same set its earlier attempt was writing entries for. Null until the
     * first run has assembled it.
     */
    sourceBundle: text("source_bundle", { mode: "json" }).$type<RecapSourceBundle>(),
  },
  (t) => ({
    /**
     * Lookup index for the most-common read patterns: the UI's "recaps for
     * this repo, this period, newest first" and the scheduler's "does a
     * non-superseded recap already exist for this period?" check.
     */
    repoPeriodStartIdx: index("project_recaps_repo_period_start_idx").on(
      t.repositoryId,
      t.period,
      t.periodStart,
    ),
    /** Boot-time `resumePending` enumeration index. */
    statusIdx: index("project_recaps_status_idx").on(t.status),
  }),
);
