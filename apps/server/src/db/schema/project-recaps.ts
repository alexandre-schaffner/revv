import { type AnySQLiteColumn, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { repositories } from "./repositories";

/**
 * Daily / weekly recap of recently-archived PRs in a repository.
 *
 * Content is produced through a single-phase MCP-routed pipeline (compared to
 * the walkthrough's 4-phase A→B→C→D doctrine). One atomic write of the recap
 * overview + source provenance + summary stats by the agent's
 * `commit_recap_overview` MCP tool (which reads the markdown body from the
 * orchestrator's per-job text buffer rather than a tool argument, so the
 * model only emits the markdown once — as visible assistant text); the
 * orchestrator transitions `status` to `'complete'` only after
 * `complete_recap` validates the row.
 *
 * Immutability: a recap is keyed on `(repositoryId, period, periodStart)`. On
 * regenerate, the existing row is marked `'superseded'` (with
 * `supersededBy` pointing at the replacement) and a fresh row is inserted —
 * mirroring the walkthrough supersession pattern so audit trails survive.
 *
 * Empty windows do not produce rows: the scheduler skips a `(repo, period,
 * start)` tuple when `listArchivedPrsForWindow` returns zero PRs, so the
 * recap list shows a gap rather than a "nothing to report" placeholder.
 *
 * Cross-cutting decisions baked into the schema:
 *   • Period boundaries are stored as ISO UTC strings, inclusive lower /
 *     exclusive upper. No timezone column — UTC for v1 (CLAUDE.md plan).
 *   • Source PR / walkthrough provenance is JSON arrays on the row, not a
 *     child table. Promotable later if querying provenance becomes a hot
 *     path; for now the read pattern is "fetch one recap, render it".
 */
export const projectRecaps = sqliteTable(
  "project_recaps",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** `'daily' | 'weekly'`. Application-level enum; SQLite has no native enum. */
    period: text("period").notNull(),
    /** Inclusive lower bound on the period window (ISO 8601 UTC). */
    periodStart: text("period_start").notNull(),
    /** Exclusive upper bound on the period window (ISO 8601 UTC). */
    periodEnd: text("period_end").notNull(),
    /**
     * Markdown body of the recap, written atomically by the
     * `commit_recap_overview` MCP tool (which reads it from the orchestrator's
     * in-memory text buffer). Empty until the agent has produced it; the
     * orchestrator's validation gate (`complete_recap`) refuses to transition
     * status to 'complete' unless this is non-empty.
     */
    overview: text("overview").notNull().default(""),
    /**
     * Job lifecycle status — owned exclusively by
     * `ProjectRecapJobs.setStatus` (single-writer per CLAUDE.md
     * invariant #11). Agents NEVER write this field.
     *   `generating` — job running or resumable
     *   `complete`   — `complete_recap` validation passed
     *   `error`      — terminal failure (exceeded retries / unrecoverable)
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
    /** Model identifier used to produce this recap (e.g. `claude-opus-4-7`). */
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
     * Resume-on-boot counter, bounded by `RECAP_MAX_RESUME_ATTEMPTS`. Rows
     * exceeding the cap transition to `'error'` and the orchestrator stops
     * relaunching them.
     */
    resumeAttempts: integer("resume_attempts").notNull().default(0),
    /**
     * Human-readable failure reason when `status='error'`. Written by the
     * orchestrator (single-writer per CLAUDE.md invariant #11) so the UI can
     * show a specific message instead of a generic "Generation failed."
     */
    errorMessage: text("error_message"),
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
