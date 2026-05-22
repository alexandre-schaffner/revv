// ─── WalkthroughService ──────────────────────────────────────────────────────
//
// Thin DB adapter for the walkthroughs tables. Scope is deliberately narrow
// post-refactor:
//
//   • ORCHESTRATOR LIFECYCLE writes (per doctrine invariant #2 + #11):
//     - createPartial    (inserts the row when a job begins)
//     - setStatus        (generating → complete | error | superseded)
//     - supersede        (old row → superseded, links to new row)
//     - setOpencodeSessionId (opencode continuation id)
//     - incrementResumeAttempts (resume counter)
//     - markIssuesSubmitted (GitHub push bookkeeping)
//
//   • READ-SIDE:
//     - getCached
//     - getPartial
//     - listGenerating
//
// Content writes (summary/risk, diff steps, issues, ratings, sentiment) are
// NOT here — they live inside MCP tool handlers in walkthrough-tools.ts, per
// doctrine invariant #2 ("agent content writes go through MCP, only"). Any
// method that used to synthesize content on behalf of an agent is gone.

import type {
  Confidence,
  GenerationProviderConfig,
  RatingAxis,
  RatingCitation,
  RiskLevel,
  Verdict,
  Walkthrough,
  WalkthroughBlock,
  WalkthroughIssue,
  WalkthroughPipelinePhase,
  WalkthroughRating,
  WalkthroughSemanticStep,
  WalkthroughStatus,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { and, asc, desc, eq, gt, inArray, ne } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { commentThreads } from "../db/schema/comment-threads";
import { pullRequests } from "../db/schema/pull-requests";
import { repositories } from "../db/schema/repositories";
import { walkthroughBlocks } from "../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../db/schema/walkthrough-semantic-steps";
import { walkthroughs } from "../db/schema/walkthroughs";
import { ReviewError } from "../domain/errors";
import { DbService } from "./Db";
import type { PrCommit } from "./GitHub";

// ── Row-to-domain converter ─────────────────────────────────────────────────

function rowToRating(row: typeof walkthroughRatings.$inferSelect): WalkthroughRating {
  let citations: RatingCitation[] = [];
  try {
    const parsed: unknown = JSON.parse(row.citations);
    if (Array.isArray(parsed)) {
      citations = parsed.filter(
        (v): v is RatingCitation =>
          typeof v === "object" &&
          v !== null &&
          typeof (v as { filePath?: unknown }).filePath === "string" &&
          typeof (v as { startLine?: unknown }).startLine === "number" &&
          typeof (v as { endLine?: unknown }).endLine === "number",
      );
    }
  } catch {
    // Corrupt JSON — fall back to no citations.
  }

  let blockIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.blockIds);
    if (Array.isArray(parsed)) {
      blockIds = parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // Corrupt JSON — fall back to no block links.
  }

  return {
    axis: row.axis as RatingAxis,
    verdict: row.verdict as Verdict,
    confidence: row.confidence as Confidence,
    rationale: row.rationale,
    details: row.details,
    citations,
    blockIds,
  };
}

function rowToWalkthrough(
  row: typeof walkthroughs.$inferSelect,
  semanticSteps: Array<typeof walkthroughSemanticSteps.$inferSelect>,
  blocks: Array<typeof walkthroughBlocks.$inferSelect>,
  issues: Array<typeof walkthroughIssues.$inferSelect>,
  ratings: Array<typeof walkthroughRatings.$inferSelect>,
): Walkthrough {
  const sortedSemanticSteps: WalkthroughSemanticStep[] = [...semanticSteps]
    .sort((a, b) => a.semanticStepIndex - b.semanticStepIndex)
    .map((s) => ({
      semanticStepIndex: s.semanticStepIndex,
      title: s.title,
      summary: s.summary ?? null,
    }));

  const sortedBlocks = [...blocks]
    .sort((a, b) => a.semanticStepIndex - b.semanticStepIndex || a.stepIndex - b.stepIndex)
    .map((b) => JSON.parse(b.data) as WalkthroughBlock);

  const sortedIssues = [...issues]
    .sort((a, b) => a.order - b.order)
    .map((i): WalkthroughIssue => {
      let blockIds: string[] = [];
      try {
        const parsed: unknown = JSON.parse(i.blockIds);
        if (Array.isArray(parsed)) {
          blockIds = parsed.filter((v): v is string => typeof v === "string");
        }
      } catch {
        // Legacy row or corrupt JSON — fall back to empty linkage.
      }
      return {
        id: i.id,
        severity: i.severity as WalkthroughIssue["severity"],
        title: i.title,
        description: i.description,
        blockIds,
        ...(i.filePath !== null ? { filePath: i.filePath } : {}),
        ...(i.startLine !== null ? { startLine: i.startLine } : {}),
        ...(i.endLine !== null ? { endLine: i.endLine } : {}),
        ...(i.submittedAt !== null ? { submittedAt: i.submittedAt } : {}),
      };
    });

  // Ratings are ordered by insertion (createdAt) so the grid receives them
  // in arrival order. The UI re-orders by canonical RATING_AXES for display.
  const sortedRatings = [...ratings]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(rowToRating);

  let providerConfig: Walkthrough["providerConfig"] = null;
  if (row.providerConfig) {
    try {
      const parsed = JSON.parse(row.providerConfig) as Record<string, unknown>;
      providerConfig = {
        provider: typeof parsed.provider === "string" ? parsed.provider : row.modelUsed,
        model: typeof parsed.model === "string" ? parsed.model : row.modelUsed,
        thinkingEffort: typeof parsed.thinkingEffort === "string" ? parsed.thinkingEffort : null,
        contextWindow: typeof parsed.contextWindow === "string" ? parsed.contextWindow : null,
        maxTurns: typeof parsed.maxTurns === "number" ? parsed.maxTurns : 0,
      };
    } catch {
      providerConfig = null;
    }
  }

  const generatedBy: Walkthrough["generatedBy"] =
    row.generatedByGithubLogin || row.generatedByGithubUserId
      ? {
          githubUserId: row.generatedByGithubUserId ?? null,
          githubLogin: row.generatedByGithubLogin ?? null,
          displayName: row.generatedByDisplayName ?? null,
          avatarUrl: row.generatedByAvatarUrl ?? null,
        }
      : null;

  return {
    id: row.id,
    reviewSessionId: row.reviewSessionId,
    pullRequestId: row.pullRequestId,
    summary: row.summary,
    sentiment: row.sentiment ?? null,
    semanticSteps: sortedSemanticSteps,
    blocks: sortedBlocks,
    issues: sortedIssues,
    ratings: sortedRatings,
    lastCompletedPhase: row.lastCompletedPhase as WalkthroughPipelinePhase,
    riskLevel: row.riskLevel as RiskLevel,
    generatedAt: row.generatedAt,
    modelUsed: row.modelUsed,
    tokenUsage: JSON.parse(row.tokenUsage) as WalkthroughTokenUsage,
    prHeadSha: row.prHeadSha,
    generatedBy,
    providerConfig,
  };
}

// ── Service definition ──────────────────────────────────────────────────────

export class WalkthroughService extends Context.Tag("WalkthroughService")<
  WalkthroughService,
  {
    /**
     * Insert a new walkthrough row at start of generation. Behavior depends
     * on whether a row already exists at `(prId, prHeadSha)`:
     *
     *   • no row              → INSERT a fresh row, return its id.
     *   • row in 'generating' → return the existing id (the in-flight job
     *                            owns this row; concurrent startJob is
     *                            idempotent).
     *   • row in 'complete'   → return the existing id (caller is expected
     *                            to have hit the cache path first; defensive
     *                            no-op so we never clobber a finished
     *                            walkthrough).
     *   • row in 'superseded' → RECYCLE: delete the stale row (cascades
     *                            blocks/issues/ratings + AI-authored
     *                            comment_threads via the issue FK) and
     *                            insert a fresh row with a new id. This is
     *                            the regenerate path — the user explicitly
     *                            asked for a do-over at the same head SHA,
     *                            so the failed/cancelled prior attempt's
     *                            content is intentionally cleared.
     *   • row in 'error'      → RECYCLE: same as superseded. The row is
     *                            terminal and has no live fiber, so a fresh
     *                            run replaces it cleanly.
     *
     * All-in-one transaction so the lookup + delete + insert can't race a
     * concurrent startJob for the same (prId, prHeadSha).
     */
    readonly createPartial: (params: {
      id?: string;
      reviewSessionId: string;
      prId: string;
      modelUsed: string;
      prHeadSha: string;
      /**
       * PR commit list (oldest → newest, post-reverse) captured from GitHub
       * at job start. Persisted as JSON on the walkthrough row; the agent
       * fetches it via `get_commit_history` MCP read tool when authoring
       * the required "How we got here" journey chapter. Optional for
       * callers that haven't been migrated yet; new rows without commits
       * will surface as an empty list to the agent and trigger the
       * single-commit edge-case path.
       */
      prCommits?: readonly PrCommit[];
      /**
       * GitHub identity of the account that triggered this generation job.
       * Stamped on the row at creation and carried along when the
       * snapshot is exported to the remote cache. Optional so callers that
       * predate the attribution columns continue to compile — the columns
       * are nullable and the UI degrades gracefully.
       */
      generatedBy?: {
        readonly githubUserId: number;
        readonly githubLogin: string;
        readonly displayName: string | null;
        readonly avatarUrl: string | null;
      };
      /**
       * Snapshot of the AI provider config in effect at job start. Stored
       * as JSON on `provider_config`. Pairs with `modelUsed` — the
       * column survives a mid-job settings change.
       */
      providerConfig?: GenerationProviderConfig;
    }) => Effect.Effect<string, ReviewError, DbService>;

    /**
     * Set `walkthroughs.status`. The ONLY caller is {@link WalkthroughJobs};
     * every other module that needs to transition lifecycle goes through
     * the orchestrator (doctrine invariant #11).
     */
    readonly setStatus: (
      walkthroughId: string,
      status: WalkthroughStatus,
      options?: { tokenUsage?: WalkthroughTokenUsage },
    ) => Effect.Effect<void, never, DbService>;

    /**
     * Atomically mark `oldId` as `'superseded'` with `supersededBy = newId`.
     * Called by {@link WalkthroughJobs.supersedeWalkthrough} when the PR
     * gets a new head SHA. Per doctrine invariant #7, walkthroughs are
     * immutable per head SHA — a new commit produces a new row, never
     * mutates the old.
     */
    readonly supersede: (oldId: string, newId: string) => Effect.Effect<void, never, DbService>;

    /**
     * Mark all non-superseded walkthroughs for a PR as 'superseded'.
     * `supersededBy` is left NULL — it gets backfilled when a new
     * walkthrough row is subsequently created for the PR's new head SHA,
     * or stays NULL if no new walkthrough is ever generated. Called by
     * {@link WalkthroughJobs.supersedeForPr} in response to a detected
     * head-SHA change.
     *
     * `exceptHeadSha`: rows whose `prHeadSha` matches this value are
     * skipped. PollScheduler uses this to spare a freshly-created
     * walkthrough at the just-detected new SHA from being marked
     * superseded by the very poll cycle that observed the SHA change.
     */
    readonly supersedeAllForPr: (
      prId: string,
      exceptHeadSha?: string,
    ) => Effect.Effect<void, never, DbService>;

    /** Get a complete (cached) walkthrough by PR + sha. */
    readonly getCached: (
      prId: string,
      headSha: string,
    ) => Effect.Effect<Walkthrough | null, never, DbService>;

    /**
     * Get an incomplete (generating/error) walkthrough + its blocks for resume.
     * Superseded rows are NOT returned — they're terminal from the job's perspective.
     */
    readonly getPartial: (
      prId: string,
      headSha: string,
    ) => Effect.Effect<
      | (Walkthrough & {
          status: "generating" | "error";
          opencodeSessionId: string | null;
        })
      | null,
      never,
      DbService
    >;

    /**
     * Return only the child rows (semanticSteps, blocks, issues, ratings) for
     * a given walkthrough that were created AFTER `since` (ISO 8601). Used by
     * the SSE cursor-filtered replay: the client already has everything up to
     * `since` from a prior `/current` REST call; this query returns only rows
     * that landed in the race window between that call and the SSE subscription.
     */
    readonly getChildRowsSince: (
      walkthroughId: string,
      since: string,
    ) => Effect.Effect<
      {
        semanticSteps: WalkthroughSemanticStep[];
        blocks: WalkthroughBlock[];
        issues: WalkthroughIssue[];
        ratings: WalkthroughRating[];
      },
      never,
      DbService
    >;

    /** Persist the opencode session ID for resumption. */
    readonly setOpencodeSessionId: (
      walkthroughId: string,
      sessionId: string,
    ) => Effect.Effect<void, never, DbService>;

    /**
     * List all walkthroughs still in `status='generating'`. Used on server boot
     * to find rows stranded by a previous crash/restart so {@link WalkthroughJobs}
     * can re-launch their generators.
     */
    readonly listGenerating: () => Effect.Effect<
      Array<{
        readonly id: string;
        readonly pullRequestId: string;
        readonly prHeadSha: string;
        readonly opencodeSessionId: string | null;
        readonly resumeAttempts: number;
      }>,
      never,
      DbService
    >;

    /**
     * Find the most recent non-superseded resumable walkthrough for a given
     * PR. Used by the manual-resume HTTP endpoint to look up which
     * walkthroughId to hand to {@link WalkthroughJobs.startJob}.
     *
     * Resumable = `status` is `'generating'` or `'error'`. The error case is
     * a user-driven retry: the orchestrator revives the row to `generating`
     * and resets the retry counter before relaunching, so the partial content
     * is preserved instead of getting recycled by `createPartial`.
     */
    readonly findResumable: (prId: string) => Effect.Effect<
      {
        readonly id: string;
        readonly pullRequestId: string;
        readonly prHeadSha: string;
        readonly status: "generating" | "error";
      } | null,
      never,
      DbService
    >;

    /**
     * Bump the row's resume counter. Returns the new value so the caller can
     * compare against `WALKTHROUGH_MAX_RESUME_ATTEMPTS` and give up cleanly.
     * Swallows DB errors — a failed bump falls back to 0 which is treated as
     * "still worth trying" by the caller.
     */
    readonly incrementResumeAttempts: (
      walkthroughId: string,
    ) => Effect.Effect<number, never, DbService>;

    /**
     * Reset the row's resume counter to 0. Called by the orchestrator on a
     * user-driven resume so the boot-time auto-resume budget restarts —
     * the user just expressed fresh intent to finish, and the prior
     * accumulation no longer reflects how many *unattended* attempts the
     * row has survived.
     */
    readonly resetResumeAttempts: (walkthroughId: string) => Effect.Effect<void, never, DbService>;

    /**
     * Update the model/agent recorded on a walkthrough row. Called by the
     * orchestrator on resume when the user has changed their AI agent since
     * the row was originally created — the new agent should be the one that
     * picks up the work.
     */
    readonly updateModelUsed: (
      walkthroughId: string,
      modelUsed: string,
    ) => Effect.Effect<void, never, DbService>;

    /**
     * Stamp the given issue ids with `submittedAt` so the UI's "already
     * posted to GitHub" state survives app restarts and PR-switches. Unknown
     * ids are silently ignored — they might have been wiped by a regenerate
     * between the reviewer opening the tab and clicking Submit. Returns the
     * timestamp that was written so the caller can echo it back to the
     * client for optimistic local state.
     */
    readonly markIssuesSubmitted: (
      issueIds: readonly string[],
    ) => Effect.Effect<string, never, DbService>;

    /**
     * Atomically increment `walkthroughs.next_seq` and return the value that
     * was current before the increment. The returned value is the `seq` to
     * stamp onto the outgoing `walkthrough:event` envelope; the post-bump
     * value is what will be returned on the *next* call.
     *
     * Sequence starts at 0 for a freshly-created walkthrough row. Survives
     * `kill -9` and resume — invariant #1 (SQLite is authoritative). Chat-
     * edit writes after `status='complete'` continue to use the same
     * counter so it strictly grows for the lifetime of the row.
     */
    readonly bumpSeq: (walkthroughId: string) => Effect.Effect<number, never, DbService>;

    /**
     * List in-flight (`status='generating'`) walkthroughs owned by the
     * given account, returning the cursor (`seqAt = next_seq - 1`) the
     * client uses to drop any in-flight events that arrived on the SSE
     * before the snapshot. The client calls this once on SSE open to seed
     * sidebar spinners and `lastSeenSeq` cursors for jobs the user isn't
     * currently viewing.
     */
    readonly listActiveForAccount: (accountId: string) => Effect.Effect<
      Array<{
        readonly prId: string;
        readonly walkthroughId: string;
        readonly prHeadSha: string;
        readonly seqAt: number;
      }>,
      never,
      DbService
    >;

    /**
     * Read the current `seqAt = next_seq - 1` cursor for a single walkthrough.
     * Used by `GET /walkthrough/current` so the client can seed its
     * `lastSeenSeq[walkthroughId]` cursor at hydration time and drop
     * envelopes already covered by the REST snapshot.
     */
    readonly getSeqAt: (walkthroughId: string) => Effect.Effect<number, never, DbService>;
  }
>() {}

// ── Live implementation ─────────────────────────────────────────────────────

export const WalkthroughServiceLive = Layer.succeed(WalkthroughService, {
  createPartial: (params) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const newId = params.id ?? crypto.randomUUID();
      const generatedAt = new Date().toISOString();

      // Atomically: look at any existing row at (prId, prHeadSha), recycle
      // it if it's terminal (superseded/error), otherwise reuse it. The
      // transaction ensures concurrent startJob calls for the same
      // (prId, prHeadSha) can't race the delete-then-insert and produce
      // duplicate rows or zero rows.
      //
      // Cascade chain on DELETE walkthroughs:
      //   walkthrough_blocks   (FK onDelete: cascade)
      //   walkthrough_issues   (FK onDelete: cascade)
      //     └─ comment_threads.walkthrough_issue_id (FK onDelete: cascade)
      //        — drops AI-authored inline comments tied to the failed run
      //   walkthrough_ratings  (FK onDelete: cascade)
      // Other walkthroughs that referenced this row via supersededBy get
      // their pointer NULLed (FK onDelete: set null), which is fine — the
      // audit chain just truncates at the recycled row.
      const result = yield* Effect.try({
        try: () =>
          db.transaction((tx): { id: string } => {
            const existing = tx
              .select({
                id: walkthroughs.id,
                status: walkthroughs.status,
              })
              .from(walkthroughs)
              .where(
                and(
                  eq(walkthroughs.pullRequestId, params.prId),
                  eq(walkthroughs.prHeadSha, params.prHeadSha),
                ),
              )
              .get();

            if (existing) {
              if (existing.status === "generating" || existing.status === "complete") {
                // In-flight or finished — keep the row. The
                // orchestrator's idempotent-startJob and cache
                // paths upstream of this call already handle
                // these cases; we only reach here on a race.
                return { id: existing.id };
              }
              // 'superseded' or 'error' — drop the row. Cascades
              // clean every child row tied to the prior attempt.
              tx.delete(walkthroughs).where(eq(walkthroughs.id, existing.id)).run();
            }

            tx.insert(walkthroughs)
              .values({
                id: newId,
                reviewSessionId: params.reviewSessionId,
                pullRequestId: params.prId,
                summary: "",
                riskLevel: "low",
                sentiment: null,
                status: "generating",
                lastCompletedPhase: "none",
                generatedAt,
                modelUsed: params.modelUsed,
                tokenUsage: "{}",
                prHeadSha: params.prHeadSha,
                resumeAttempts: 0,
                prCommits: params.prCommits ? JSON.stringify(params.prCommits) : null,
                generatedByGithubUserId: params.generatedBy?.githubUserId ?? null,
                generatedByGithubLogin: params.generatedBy?.githubLogin ?? null,
                generatedByDisplayName: params.generatedBy?.displayName ?? null,
                generatedByAvatarUrl: params.generatedBy?.avatarUrl ?? null,
                providerConfig: params.providerConfig
                  ? JSON.stringify(params.providerConfig)
                  : null,
              })
              .run();
            return { id: newId };
          }),
        catch: (e) =>
          new ReviewError({
            message: `Failed to create walkthrough: ${String(e)}`,
          }),
      });

      return result.id;
    }),

  setStatus: (walkthroughId, status, options) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      // `completedAt` is stamped exactly when status transitions to
      // 'complete'. This is the canonical "walkthrough finished" timestamp
      // the recap pipeline windows on — distinct from `generatedAt`
      // (job-start) so a walkthrough that started in period N but finished
      // in period N+1 lands in N+1's recap. We deliberately do NOT clear
      // it on any other transition: a row that briefly hit 'complete'
      // then got 'superseded' retains its completedAt for audit.
      const completedAtPatch =
        status === "complete" ? { completedAt: new Date().toISOString() } : {};
      db.update(walkthroughs)
        .set({
          status,
          ...completedAtPatch,
          ...(options?.tokenUsage ? { tokenUsage: JSON.stringify(options.tokenUsage) } : {}),
        })
        .where(eq(walkthroughs.id, walkthroughId))
        .run();
    }).pipe(Effect.catchAll(() => Effect.void)),

  supersede: (oldId, newId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      db.transaction(() => {
        // Drop AI-authored comment threads tied to the outgoing walkthrough's
        // issues. Human threads (walkthroughIssueId IS NULL) are untouched.
        // The walkthroughs row itself is kept for audit (superseded_by chain);
        // we can't rely on the cascade-on-delete path here.
        const issueIds = db
          .select({ id: walkthroughIssues.id })
          .from(walkthroughIssues)
          .where(eq(walkthroughIssues.walkthroughId, oldId))
          .all()
          .map((r) => r.id);
        if (issueIds.length > 0) {
          db.delete(commentThreads)
            .where(inArray(commentThreads.walkthroughIssueId, issueIds))
            .run();
        }
        db.update(walkthroughs)
          .set({ status: "superseded", supersededBy: newId })
          .where(eq(walkthroughs.id, oldId))
          .run();
      });
    }).pipe(Effect.catchAll(() => Effect.void)),

  supersedeAllForPr: (prId, exceptHeadSha) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      db.transaction(() => {
        // Collect the IDs of every walkthrough that is about to be superseded.
        // `exceptHeadSha` excludes a specific head-SHA from the sweep —
        // that's how the SHA-aware PollScheduler path avoids marking the
        // freshly-created walkthrough at the new head as stale.
        const baseConditions = [
          eq(walkthroughs.pullRequestId, prId),
          ne(walkthroughs.status, "superseded"),
        ];
        const condition =
          exceptHeadSha !== undefined
            ? and(...baseConditions, ne(walkthroughs.prHeadSha, exceptHeadSha))
            : and(...baseConditions);

        const activeIds = db
          .select({ id: walkthroughs.id })
          .from(walkthroughs)
          .where(condition)
          .all()
          .map((r) => r.id);

        if (activeIds.length === 0) return;

        // Drop all AI-authored comment threads linked to those walkthroughs'
        // issues before marking the rows superseded.
        const issueIds = db
          .select({ id: walkthroughIssues.id })
          .from(walkthroughIssues)
          .where(inArray(walkthroughIssues.walkthroughId, activeIds))
          .all()
          .map((r) => r.id);
        if (issueIds.length > 0) {
          db.delete(commentThreads)
            .where(inArray(commentThreads.walkthroughIssueId, issueIds))
            .run();
        }

        db.update(walkthroughs).set({ status: "superseded" }).where(condition).run();
      });
    }).pipe(Effect.catchAll(() => Effect.void)),

  getCached: (prId, headSha) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;

      const row = db
        .select()
        .from(walkthroughs)
        .where(
          and(
            eq(walkthroughs.pullRequestId, prId),
            eq(walkthroughs.prHeadSha, headSha),
            eq(walkthroughs.status, "complete"),
          ),
        )
        .get();

      if (!row) return null;

      const semanticSteps = db
        .select()
        .from(walkthroughSemanticSteps)
        .where(eq(walkthroughSemanticSteps.walkthroughId, row.id))
        .orderBy(asc(walkthroughSemanticSteps.semanticStepIndex))
        .all();

      const blocks = db
        .select()
        .from(walkthroughBlocks)
        .where(eq(walkthroughBlocks.walkthroughId, row.id))
        .all();

      const issues = db
        .select()
        .from(walkthroughIssues)
        .where(eq(walkthroughIssues.walkthroughId, row.id))
        .all();

      const ratings = db
        .select()
        .from(walkthroughRatings)
        .where(eq(walkthroughRatings.walkthroughId, row.id))
        .all();

      return rowToWalkthrough(row, semanticSteps, blocks, issues, ratings);
    }),

  getPartial: (prId, headSha) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;

      // "Partial" = not yet 'complete' and not 'superseded'. Superseded
      // rows are terminal from a resume perspective — their head_sha is
      // stale and their supersededBy target is the active one.
      const row = db
        .select()
        .from(walkthroughs)
        .where(
          and(
            eq(walkthroughs.pullRequestId, prId),
            eq(walkthroughs.prHeadSha, headSha),
            ne(walkthroughs.status, "complete"),
            ne(walkthroughs.status, "superseded"),
          ),
        )
        .get();

      if (!row) return null;

      const semanticSteps = db
        .select()
        .from(walkthroughSemanticSteps)
        .where(eq(walkthroughSemanticSteps.walkthroughId, row.id))
        .orderBy(asc(walkthroughSemanticSteps.semanticStepIndex))
        .all();

      const blocks = db
        .select()
        .from(walkthroughBlocks)
        .where(eq(walkthroughBlocks.walkthroughId, row.id))
        .all();

      const issues = db
        .select()
        .from(walkthroughIssues)
        .where(eq(walkthroughIssues.walkthroughId, row.id))
        .all();

      const ratings = db
        .select()
        .from(walkthroughRatings)
        .where(eq(walkthroughRatings.walkthroughId, row.id))
        .all();

      return {
        ...rowToWalkthrough(row, semanticSteps, blocks, issues, ratings),
        status: row.status as "generating" | "error",
        opencodeSessionId: row.opencodeSessionId ?? null,
      };
    }),

  setOpencodeSessionId: (walkthroughId, sessionId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      db.update(walkthroughs)
        .set({ opencodeSessionId: sessionId })
        .where(eq(walkthroughs.id, walkthroughId))
        .run();
    }).pipe(Effect.catchAll(() => Effect.void)),

  listGenerating: () =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const rows = db
        .select({
          id: walkthroughs.id,
          pullRequestId: walkthroughs.pullRequestId,
          prHeadSha: walkthroughs.prHeadSha,
          opencodeSessionId: walkthroughs.opencodeSessionId,
          resumeAttempts: walkthroughs.resumeAttempts,
        })
        .from(walkthroughs)
        .where(eq(walkthroughs.status, "generating"))
        .all();
      return rows.map((r) => ({
        id: r.id,
        pullRequestId: r.pullRequestId,
        prHeadSha: r.prHeadSha,
        opencodeSessionId: r.opencodeSessionId ?? null,
        resumeAttempts: r.resumeAttempts,
      }));
    }),

  findResumable: (prId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = db
        .select({
          id: walkthroughs.id,
          pullRequestId: walkthroughs.pullRequestId,
          prHeadSha: walkthroughs.prHeadSha,
          status: walkthroughs.status,
        })
        .from(walkthroughs)
        .where(
          and(
            eq(walkthroughs.pullRequestId, prId),
            inArray(walkthroughs.status, ["generating", "error"]),
          ),
        )
        .orderBy(desc(walkthroughs.generatedAt))
        .get();
      if (!row) return null;
      return {
        id: row.id,
        pullRequestId: row.pullRequestId,
        prHeadSha: row.prHeadSha,
        status: row.status as "generating" | "error",
      };
    }),

  incrementResumeAttempts: (walkthroughId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = db
        .select({ resumeAttempts: walkthroughs.resumeAttempts })
        .from(walkthroughs)
        .where(eq(walkthroughs.id, walkthroughId))
        .get();
      const next = (row?.resumeAttempts ?? 0) + 1;
      db.update(walkthroughs)
        .set({ resumeAttempts: next })
        .where(eq(walkthroughs.id, walkthroughId))
        .run();
      return next;
    }).pipe(Effect.catchAll(() => Effect.succeed(0))),

  resetResumeAttempts: (walkthroughId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      db.update(walkthroughs)
        .set({ resumeAttempts: 0 })
        .where(eq(walkthroughs.id, walkthroughId))
        .run();
    }).pipe(Effect.catchAll(() => Effect.void)),

  updateModelUsed: (walkthroughId, modelUsed) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      db.update(walkthroughs).set({ modelUsed }).where(eq(walkthroughs.id, walkthroughId)).run();
    }).pipe(Effect.catchAll(() => Effect.void)),

  markIssuesSubmitted: (issueIds) =>
    Effect.gen(function* () {
      const submittedAt = new Date().toISOString();
      if (issueIds.length === 0) return submittedAt;
      const { db } = yield* DbService;
      db.update(walkthroughIssues)
        .set({ submittedAt })
        .where(inArray(walkthroughIssues.id, [...issueIds]))
        .run();
      return submittedAt;
    }).pipe(Effect.catchAll(() => Effect.succeed(new Date().toISOString()))),

  bumpSeq: (walkthroughId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      return db.transaction((tx): number => {
        const row = tx
          .select({ nextSeq: walkthroughs.nextSeq })
          .from(walkthroughs)
          .where(eq(walkthroughs.id, walkthroughId))
          .get();
        const seq = row?.nextSeq ?? 0;
        tx.update(walkthroughs)
          .set({ nextSeq: seq + 1 })
          .where(eq(walkthroughs.id, walkthroughId))
          .run();
        return seq;
      });
    }).pipe(Effect.catchAll(() => Effect.succeed(0))),

  listActiveForAccount: (accountId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const rows = db
        .select({
          walkthroughId: walkthroughs.id,
          prId: walkthroughs.pullRequestId,
          prHeadSha: walkthroughs.prHeadSha,
          nextSeq: walkthroughs.nextSeq,
        })
        .from(walkthroughs)
        .innerJoin(pullRequests, eq(pullRequests.id, walkthroughs.pullRequestId))
        .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
        .where(and(eq(walkthroughs.status, "generating"), eq(repositories.accountId, accountId)))
        .all();
      return rows.map((r) => ({
        prId: r.prId,
        walkthroughId: r.walkthroughId,
        prHeadSha: r.prHeadSha,
        seqAt: Math.max(0, r.nextSeq - 1),
      }));
    }).pipe(Effect.catchAll(() => Effect.succeed([]))),

  getSeqAt: (walkthroughId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = db
        .select({ nextSeq: walkthroughs.nextSeq })
        .from(walkthroughs)
        .where(eq(walkthroughs.id, walkthroughId))
        .get();
      return Math.max(0, (row?.nextSeq ?? 1) - 1);
    }).pipe(Effect.catchAll(() => Effect.succeed(0))),

  getChildRowsSince: (walkthroughId, since) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;

      const semanticStepRows = db
        .select()
        .from(walkthroughSemanticSteps)
        .where(
          and(
            eq(walkthroughSemanticSteps.walkthroughId, walkthroughId),
            gt(walkthroughSemanticSteps.createdAt, since),
          ),
        )
        .orderBy(asc(walkthroughSemanticSteps.semanticStepIndex))
        .all();

      const blockRows = db
        .select()
        .from(walkthroughBlocks)
        .where(
          and(
            eq(walkthroughBlocks.walkthroughId, walkthroughId),
            gt(walkthroughBlocks.createdAt, since),
          ),
        )
        .all();

      const issueRows = db
        .select()
        .from(walkthroughIssues)
        .where(
          and(
            eq(walkthroughIssues.walkthroughId, walkthroughId),
            gt(walkthroughIssues.createdAt, since),
          ),
        )
        .all();

      const ratingRows = db
        .select()
        .from(walkthroughRatings)
        .where(
          and(
            eq(walkthroughRatings.walkthroughId, walkthroughId),
            gt(walkthroughRatings.createdAt, since),
          ),
        )
        .all();

      const semanticSteps: WalkthroughSemanticStep[] = semanticStepRows.map((s) => ({
        semanticStepIndex: s.semanticStepIndex,
        title: s.title,
        summary: s.summary ?? null,
      }));

      const blocks = [...blockRows]
        .sort((a, b) => a.semanticStepIndex - b.semanticStepIndex || a.stepIndex - b.stepIndex)
        .map((b) => JSON.parse(b.data) as WalkthroughBlock);

      const issues = [...issueRows]
        .sort((a, b) => a.order - b.order)
        .map((i): WalkthroughIssue => {
          let blockIds: string[] = [];
          try {
            const parsed: unknown = JSON.parse(i.blockIds);
            if (Array.isArray(parsed)) {
              blockIds = parsed.filter((v): v is string => typeof v === "string");
            }
          } catch {
            // corrupt JSON — fall back to empty
          }
          return {
            id: i.id,
            severity: i.severity as WalkthroughIssue["severity"],
            title: i.title,
            description: i.description,
            blockIds,
            ...(i.filePath !== null ? { filePath: i.filePath } : {}),
            ...(i.startLine !== null ? { startLine: i.startLine } : {}),
            ...(i.endLine !== null ? { endLine: i.endLine } : {}),
            ...(i.submittedAt !== null ? { submittedAt: i.submittedAt } : {}),
          };
        });

      const ratings = [...ratingRows]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(rowToRating);

      return { semanticSteps, blocks, issues, ratings };
    }).pipe(
      Effect.catchAll(() =>
        Effect.succeed({ semanticSteps: [], blocks: [], issues: [], ratings: [] }),
      ),
    ),
});
