import { type AnySQLiteColumn, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { repositories } from "./repositories";

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
     * Short (1–3 sentences) model-written lede for the structured recap. May
     * contain `<strong>` / `<em>` tags only; everything else is stripped at
     * render time. Written atomically by the `set_lede` MCP tool. Validation
     * gate (`complete_recap`) requires non-empty before transitioning status.
     */
    lede: text("lede").notNull().default(""),
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
