import {
  type AnySQLiteColumn,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { pullRequests } from "./pull-requests";
import { reviewSessions } from "./review-sessions";

/**
 * A generated AI walkthrough of a PR, pinned to a specific head SHA.
 *
 * Content is produced through a strict 4-phase pipeline (A→B→C→D) enforced at
 * the schema, MCP tool, and orchestrator level. See
 * "Agent Subsystem Invariants" in the root CLAUDE.md for the full doctrine.
 *
 * Immutability: a walkthrough is pinned to one `pr_head_sha`. A new commit on
 * the PR never mutates an existing row — the old row is marked `'superseded'`
 * with `superseded_by` pointing at the replacement, and a fresh row is
 * inserted. This preserves audit trail and guarantees clients see a
 * consistent view even mid-regeneration.
 */
export const walkthroughs = sqliteTable(
  "walkthroughs",
  {
    id: text("id").primaryKey(),
    reviewSessionId: text("review_session_id")
      .notNull()
      .references(() => reviewSessions.id, { onDelete: "cascade" }),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    /**
     * Phase A output: 2-3 sentence PR summary. Written by `set_overview` MCP
     * tool. Defaults to empty string at row creation so the orchestrator can
     * insert the row before Phase A runs — `lastCompletedPhase === 'none'`
     * is the signal that summary isn't populated yet.
     */
    summary: text("summary").notNull().default(""),
    /** Phase A output: `'low' | 'medium' | 'high'`. Written by `set_overview` MCP tool. */
    riskLevel: text("risk_level").notNull().default("low"),
    /**
     * Phase C output: final "Overall Sentiment" paragraph. Nullable until
     * Phase C completes. Written by `set_sentiment` MCP tool.
     */
    sentiment: text("sentiment"),
    /**
     * Job lifecycle status — owned exclusively by `WalkthroughJobs.setStatus`.
     * Agents never write this field directly.
     *   `generating` — job running or resumable
     *   `complete`   — `complete_walkthrough` validation passed
     *   `error`      — terminal failure (exceeded retries / unrecoverable)
     *   `superseded` — a newer walkthrough (see `supersededBy`) replaced this
     */
    status: text("status").notNull().default("generating"),
    /**
     * Monotonically-advancing phase pointer — `'none' | 'A' | 'B' | 'C' | 'D'`.
     * Advanced as a side effect of the MCP tool writes that complete each phase
     * (transactionally, in the same `db.transaction` as the content write).
     */
    lastCompletedPhase: text("last_completed_phase").notNull().default("none"),
    /**
     * Self-FK set when `status='superseded'`: points at the walkthrough row
     * that replaces this one (always same PR, newer head SHA).
     */
    supersededBy: text("superseded_by").references((): AnySQLiteColumn => walkthroughs.id, {
      onDelete: "set null",
    }),
    generatedAt: text("generated_at").notNull(),
    /**
     * ISO 8601 timestamp set when {@link WalkthroughJobs.setStatus} transitions
     * this row to `status='complete'`. Distinct from `generatedAt` (which is
     * the job-start timestamp): the recap pipeline windows on *finish* time so
     * a walkthrough that started in period N but finished in period N+1 lands
     * in N+1's recap, not N's. Nullable for rows that haven't completed yet.
     *
     * Backfill on migration 0220: existing `status='complete'` rows get
     * `completedAt = generatedAt` so historical walkthroughs are visible to
     * the first recap run.
     */
    completedAt: text("completed_at"),
    modelUsed: text("model_used").notNull(),
    tokenUsage: text("token_usage").notNull().default("{}"),
    prHeadSha: text("pr_head_sha").notNull(),
    opencodeSessionId: text("opencode_session_id"),
    // Incremented each time WalkthroughJobs.resumePending() picks this row back up
    // after a server restart. Capped at WALKTHROUGH_MAX_RESUME_ATTEMPTS before the
    // row is marked `error` and left alone.
    resumeAttempts: integer("resume_attempts").notNull().default(0),
    /**
     * ISO 8601 timestamp of the most recent chat-driven edit. Null until
     * the first chat-edit MCP tool call mutates this row. The generation
     * pipeline NEVER writes this column — it is the marker of the post-
     * completion chat-edit carve-out (CLAUDE.md invariant #7).
     */
    lastEditedAt: text("last_edited_at"),
    /**
     * Actor that performed the most recent chat-driven edit. Typically
     * `'chat:claude'` or `'chat:opencode'`. Pairs with `lastEditedAt`.
     */
    lastEditedBy: text("last_edited_by"),
    /**
     * PR commit list (JSON of `PrCommit[]`) captured from GitHub at job
     * start. Surfaced to the agent on demand via the `get_commit_history`
     * MCP read tool — never inlined in the prompt, since long PRs would
     * otherwise pay ~4.5K tokens up front on every run + resume.
     *
     * Nullable: rows created before migration 0210 read as `null`, which
     * the read tool surfaces as an empty array — the agent's single-commit
     * edge-case path then renders a one-paragraph journey chapter and
     * moves on.
     */
    prCommits: text("pr_commits"),
  },
  (t) => ({
    /**
     * Enforces the doctrine invariant "one walkthrough per (PR, head_sha)" at the
     * database level. Makes `WalkthroughJobs.startJob` naturally idempotent:
     * concurrent starts upsert onto the same row instead of spawning duplicates.
     * Superseded rows share the PR but differ on head_sha, so this uniqueness
     * doesn't block new-commit flows.
     */
    prHeadShaUnique: uniqueIndex("walkthroughs_pr_head_sha_unique").on(
      t.pullRequestId,
      t.prHeadSha,
    ),
  }),
);
