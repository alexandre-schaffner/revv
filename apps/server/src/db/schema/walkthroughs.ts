import {
  type AcpAgentId,
  REVIEW_MODE,
  type ThinkingEffort,
  type WalkthroughEndReason,
  type WalkthroughMode,
  type WalkthroughStackSnapshot,
  type WalkthroughStatus,
} from "@revv/shared";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { pullRequests } from "./pull-requests";
import { reviewSessions } from "./review-sessions";

/** Per-file hash of a PR diff, keyed by filename. */
export type DiffFingerprint = Readonly<Record<string, string>>;

/**
 * What a run of this row launches with, decided once when the row is created
 * so every run of it (auto-continuations, resume-on-boot) launches the same
 * way. Null on rows created before plans were recorded.
 */
export interface WalkthroughLaunchPlan {
  readonly agent: AcpAgentId;
  readonly model: string;
  readonly thinkingEffort: ThinkingEffort | null;
  /** The job-start judgment's sizing, kept so a re-resolved launch (Resume after an error) still applies it. */
  readonly sizing: {
    readonly model?: string | undefined;
    readonly thinkingEffort?: ThinkingEffort | undefined;
  } | null;
  readonly filePriorities: ReadonlyArray<{
    readonly filename: string;
    readonly tier: number | null;
  }> | null;
  readonly splitRecommendation: { readonly pieces: number } | null;
  /** Whether a doomed run may be stopped early between auto-continuations. */
  readonly adjudicateContinuations: boolean;
}

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
    /**
     * Generation contract for this row. `reviewer`: a third-party PR review with
     * commit journey and reviewer-facing scorecard. `author`: a
     * self-review/preflight pass for the PR author.
     */
    mode: text("mode").$type<WalkthroughMode>().notNull().default(REVIEW_MODE.reviewer),
    /**
     * `'low' | 'medium' | 'high'`. Written by the orchestrator at job start
     * from the Jev risk pass (invariant 2's carve-out), passed to
     * `createPartial` so no `kill -9` gap exists before the row has a tier.
     * Falls back to `'low'` when Jev is off or unreachable.
     */
    riskLevel: text("risk_level").notNull().default("low"),
    /** Calibrated confidence [0,1] behind {@link riskLevel}; null when the tier didn't come from Jev. */
    riskConfidence: real("risk_confidence"),
    /**
     * Phase C output: final "Overall Sentiment" paragraph. Nullable until
     * Phase C completes. Written by `set_sentiment` MCP tool.
     */
    sentiment: text("sentiment"),
    /**
     * Orchestrator-only (`WalkthroughJobs`, invariant 11); agents never write it.
     *   `generating` — job running or resumable
     *   `complete`   — `complete_walkthrough` validation passed
     *   `error`      — terminal failure (exceeded retries / unrecoverable)
     *   `superseded` — a newer walkthrough (see `supersededBy`) replaced this
     */
    status: text("status").$type<WalkthroughStatus>().notNull().default("generating"),
    /**
     * Last terminal generation failure surfaced to the user. Cleared whenever
     * the row re-enters `generating` or reaches `complete`.
     */
    errorMessage: text("error_message"),
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
    /**
     * Optional parent row used by incremental refreshes. The parent is the
     * previous review artifact the agent should treat as its starting point;
     * this row remains a separate immutable artifact for the new head SHA.
     */
    parentWalkthroughId: text("parent_walkthrough_id").references(
      (): AnySQLiteColumn => walkthroughs.id,
      {
        onDelete: "set null",
      },
    ),
    /**
     * The prior PR head used as the incremental base. Null for fresh full
     * generations and for legacy rows.
     */
    baseHeadSha: text("base_head_sha"),
    /**
     * `full` generates from scratch. `incremental` produces the same visible
     * report shape, seeded by `parentWalkthroughId` and the
     * `baseHeadSha..prHeadSha` commit range.
     */
    generationMode: text("generation_mode").notNull().default("full"),
    generatedAt: text("generated_at").notNull(),
    /**
     * ISO 8601 timestamp set when the row reaches `status='complete'`. Distinct
     * from `generatedAt` (the job-start timestamp): the recap pipeline windows on
     * *finish* time so a walkthrough that started in period N but finished in
     * period N+1 lands in N+1's recap, not N's.
     */
    completedAt: text("completed_at"),
    modelUsed: text("model_used").notNull(),
    tokenUsage: text("token_usage").notNull().default("{}"),
    prHeadSha: text("pr_head_sha").notNull(),
    opencodeSessionId: text("opencode_session_id"),
    // Counted each time a resume picks this row back up after its run died.
    // Past MAX_RESUME_ATTEMPTS (services/jobs/agent-jobs.ts) the row is marked
    // `error` and left alone.
    resumeAttempts: integer("resume_attempts").notNull().default(0),
    /**
     * ISO 8601 timestamp of the most recent post-completion edit. Null until
     * the first edit MCP tool call mutates this row. The generation
     * pipeline NEVER writes this column — it is the marker of the post-
     * completion chat-edit carve-out (CLAUDE.md invariant #7).
     */
    lastEditedAt: text("last_edited_at"),
    /**
     * Actor that performed the most recent post-completion edit: `'chat:acp'`,
     * or an external coding agent's provider id (`'claude-code'`, `'codex'`, …).
     * Pairs with `lastEditedAt`.
     */
    lastEditedBy: text("last_edited_by"),
    /**
     * When the orchestrator recorded which first-pass leads this walkthrough's
     * agent was handed (`walkthrough_leads`, possibly none). Null for rows
     * that predate lead tracking or arrived from the remote cache, whose
     * leads can only be inferred from where their issues sit.
     */
    leadsSelectedAt: text("leads_selected_at"),
    /**
     * PR commit list (JSON of `PrCommit[]`) captured from GitHub at job
     * start. Surfaced to the agent on demand via the `get_commit_history`
     * MCP read tool — never inlined in the prompt, since long PRs would
     * otherwise pay ~4.5K tokens up front on every run + resume. Null on old
     * rows, which the read tool surfaces as an empty array.
     */
    prCommits: text("pr_commits"),
    /**
     * Numeric GitHub user id of the account that triggered this generation job.
     * Travels with the snapshot to the remote cache so teammates can attribute
     * who originally generated it. Null on old rows.
     */
    generatedByGithubUserId: integer("generated_by_github_user_id"),
    generatedByGithubLogin: text("generated_by_github_login"),
    generatedByDisplayName: text("generated_by_display_name"),
    /**
     * Avatar image bytes as a data URL, for the "Generated by …" badge. The
     * column name predates the switch from URLs: GitHub Enterprise avatar
     * URLs are signed and expire.
     */
    generatedByAvatarContent: text("generated_by_avatar_url"),
    /**
     * Snapshot of the agent provider config captured at job start, as JSON
     * (`GenerationProviderConfig` in `services/walkthrough-cache-format.ts`). Lets the cache hit
     * UI render "claude-opus-4-8 • thinking: high • 1m context" without
     * relying on the live settings (which may have changed since job
     * start). Captured atomically alongside `modelUsed` and never mutated.
     */
    providerConfig: text("provider_config"),
    /**
     * Monotonic per-walkthrough event counter. Incremented atomically by
     * `Walkthrough.bumpSeq()` inside the same SQLite transaction that
     * commits the content row, so the returned `seq` is durable and
     * survives `kill -9`. Stamped onto every `walkthrough:event` envelope
     * broadcast over the global SSE stream — the client uses
     * `lastSeenSeq[walkthroughId]` to defensively dedupe events that
     * arrived in flight during a reconnect (which the REST snapshot
     * already includes).
     *
     * Chat-edit writes after `status='complete'` continue to increment
     * this counter (invariant #7 carve-out), so `seq` strictly grows for
     * the lifetime of the row.
     */
    nextSeq: integer("next_seq").notNull().default(0),
    stackContext: text("stack_context", { mode: "json" }).$type<WalkthroughStackSnapshot>(),
    diffFingerprint: text("diff_fingerprint", { mode: "json" }).$type<DiffFingerprint>(),
    carriedFromWalkthroughId: text("carried_from_walkthrough_id"),
    endReason: text("end_reason").$type<WalkthroughEndReason>(),
    launchPlan: text("launch_plan", { mode: "json" }).$type<WalkthroughLaunchPlan>(),
  },
  (t) => ({
    /**
     * One live (non-superseded) walkthrough per (PR, head SHA, mode, generation
     * mode). Makes `WalkthroughJobs.startJob` idempotent: concurrent starts
     * upsert onto the same row instead of spawning duplicates.
     */
    activePrHeadShaUnique: uniqueIndex("walkthroughs_active_pr_head_sha_unique")
      .on(t.pullRequestId, t.prHeadSha, t.mode, t.generationMode)
      .where(sql`${t.status} <> 'superseded'`),
  }),
);
