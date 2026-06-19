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
  WalkthroughGenerationMode,
  WalkthroughIssue,
  WalkthroughMode,
  WalkthroughPipelinePhase,
  WalkthroughRating,
  WalkthroughReviewRound,
  WalkthroughReviewRoundsResponse,
  WalkthroughSemanticStep,
  WalkthroughStatus,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { and, asc, desc, eq, gt, inArray, ne } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { commentThreads } from "../db/schema/comment-threads";
import { pullRequests } from "../db/schema/pull-requests";
import { remoteUsers } from "../db/schema/remote-users";
import { repositories } from "../db/schema/repositories";
import { reviewRounds } from "../db/schema/review-rounds";
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
  avatarContent: string | null = null,
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
          avatarContent,
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
    mode: (row.mode ?? "reviewer") as WalkthroughMode,
    lastCompletedPhase: row.lastCompletedPhase as WalkthroughPipelinePhase,
    riskLevel: row.riskLevel as RiskLevel,
    generatedAt: row.generatedAt,
    modelUsed: row.modelUsed,
    tokenUsage: JSON.parse(row.tokenUsage) as WalkthroughTokenUsage,
    prHeadSha: row.prHeadSha,
    generationMode: row.generationMode as WalkthroughGenerationMode,
    parentWalkthroughId: row.parentWalkthroughId ?? null,
    baseHeadSha: row.baseHeadSha ?? null,
    generatedBy,
    providerConfig,
  };
}

function isPrCommit(v: unknown): v is PrCommit {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.sha === "string" &&
    typeof o.message === "string" &&
    (o.authorLogin === null || typeof o.authorLogin === "string") &&
    (o.authorAvatarUrl === null || typeof o.authorAvatarUrl === "string") &&
    (o.date === null || typeof o.date === "string")
  );
}

function parsePrCommits(raw: string | null): PrCommit[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPrCommit) : [];
  } catch {
    return [];
  }
}

function commitsInRoundRange(
  commits: readonly PrCommit[],
  fromSha: string | null,
  toSha: string,
): readonly PrCommit[] {
  const toIndex = commits.findIndex((commit) => commit.sha === toSha);
  const fromIndex = fromSha ? commits.findIndex((commit) => commit.sha === fromSha) : -1;
  if (fromSha !== null && fromSha === toSha) return [];

  if (toIndex !== -1 && fromIndex !== -1) {
    if (fromIndex < toIndex) {
      return commits.slice(fromIndex + 1, toIndex + 1);
    }
    return commits.slice(toIndex, fromIndex).reverse();
  }

  if (toIndex !== -1) {
    const prefix = commits.slice(0, toIndex + 1);
    return prefix.length > 1 && commits[0]?.sha === toSha ? prefix.reverse() : prefix;
  }

  if (fromIndex !== -1) {
    const afterFrom = commits.slice(0, fromIndex);
    return afterFrom.reverse();
  }

  return commits;
}

function subjectFromCommitMessage(message: string): string {
  return message.split("\n", 1)[0]?.trim() ?? "";
}

function cleanCommitSubject(subject: string): string {
  return subject
    .replace(/^revert\s+"?(.+?)"?$/i, "$1")
    .replace(/^\w+(?:\([^)]+\))?!?:\s+/i, "")
    .replace(/\b(?:[A-Z][A-Z0-9]+-\d+|#\d+)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLowSignalSubject(subject: string): boolean {
  return /^(?:merge|revert|chore|style|format|lint|test|tests|wip|fixup)\b/i.test(subject);
}

function toFiveWordTitle(text: string): string | null {
  const words = text
    .replace(/[`*_#()[\]{}]/g, "")
    .split(/\s+/)
    .map((word) => word.replace(/^[^\w]+|[^\w]+$/g, ""))
    .filter((word) => word.length > 0);
  if (words.length === 0) return null;
  return words.slice(0, 5).join(" ");
}

function deriveRoundFocusTitle(
  rawCommits: string | null,
  fromSha: string | null,
  toSha: string,
  fallbackCommits: readonly PrCommit[] = [],
): string | null {
  const persistedCommits = parsePrCommits(rawCommits);
  const sourceCommits = persistedCommits.length > 0 ? persistedCommits : fallbackCommits;
  const commits = commitsInRoundRange(sourceCommits, fromSha, toSha);
  const subjects = commits
    .map((commit) => subjectFromCommitMessage(commit.message))
    .filter((subject) => subject.length > 0);
  if (subjects.length === 0) return null;

  const preferred = [...subjects].reverse().find((subject) => !isLowSignalSubject(subject));
  return toFiveWordTitle(cleanCommitSubject(preferred ?? subjects.at(-1) ?? ""));
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
     *   • row in 'complete'   → return the existing id unless the caller
     *                            explicitly requested a fresh round. Fresh
     *                            rounds keep the old row as superseded audit
     *                            history and insert a new row at the same SHA.
     *   • row in 'superseded' → left in place as historical data. The active
     *                            uniqueness index excludes superseded rows.
     *   • row in 'error'      → mark historical and insert a fresh row. The
     *                            row is terminal and has no live fiber.
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
      mode?: WalkthroughMode;
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
        readonly avatarContent: string | null;
      };
      /**
       * Snapshot of the AI provider config in effect at job start. Stored
       * as JSON on `provider_config`. Pairs with `modelUsed` — the
       * column survives a mid-job settings change.
       */
      providerConfig?: GenerationProviderConfig;
      generationMode?: WalkthroughGenerationMode;
      parentWalkthroughId?: string | null;
      baseHeadSha?: string | null;
      forceNew?: boolean;
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
      mode?: WalkthroughMode,
    ) => Effect.Effect<void, never, DbService>;

    /** Get a complete (cached) walkthrough by PR + sha. */
    readonly getCached: (
      prId: string,
      headSha: string,
      mode?: WalkthroughMode,
    ) => Effect.Effect<Walkthrough | null, never, DbService>;

    /**
     * Get an incomplete (generating/error) walkthrough + its blocks for resume.
     * Superseded rows are NOT returned — they're terminal from the job's perspective.
     */
    readonly getPartial: (
      prId: string,
      headSha: string,
      mode?: WalkthroughMode,
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
        readonly mode: WalkthroughMode;
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
    readonly findResumable: (
      prId: string,
      mode?: WalkthroughMode,
    ) => Effect.Effect<
      {
        readonly id: string;
        readonly pullRequestId: string;
        readonly prHeadSha: string;
        readonly mode: WalkthroughMode;
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

    /**
     * Find the latest completed/superseded walkthrough that can seed an
     * incremental refresh for a new PR head.
     */
    readonly findLatestReviewArtifact: (prId: string) => Effect.Effect<
      {
        readonly id: string;
        readonly prHeadSha: string;
      } | null,
      never,
      DbService
    >;

    /**
     * Return the latest completed historical walkthrough for display when the
     * current PR head has no generated row yet. Unlike `getCached`, this can
     * return `superseded` rows because the reader wants to show the last
     * reviewed artifact while the user decides whether to review new commits.
     */
    readonly getLatestDisplayable: (
      prId: string,
      mode?: WalkthroughMode,
    ) => Effect.Effect<Walkthrough | null, never, DbService>;

    /**
     * Return a specific walkthrough for a PR/mode. This is a read-only
     * historical report view: callers use it to display an older report, not
     * to resume or mutate the row.
     */
    readonly getReport: (
      prId: string,
      walkthroughId: string,
      mode?: WalkthroughMode,
    ) => Effect.Effect<
      { readonly walkthrough: Walkthrough; readonly status: WalkthroughStatus } | null,
      never,
      DbService
    >;

    readonly listReviewRounds: (
      prId: string,
      currentHeadSha: string | null,
      fallbackCommits?: readonly PrCommit[],
      mode?: WalkthroughMode,
    ) => Effect.Effect<WalkthroughReviewRoundsResponse, never, DbService>;
  }
>() {}

// ── Live implementation ─────────────────────────────────────────────────────

export const WalkthroughServiceLive = Layer.succeed(WalkthroughService, {
  createPartial: (params) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const newId = params.id ?? crypto.randomUUID();
      const generatedAt = new Date().toISOString();
      const mode = params.mode ?? "reviewer";
      const generationMode = params.generationMode ?? "full";

      // Atomically: look at any existing row at (prId, prHeadSha), mark
      // terminal rows historical when a fresh row is needed, otherwise
      // reuse active rows. The transaction ensures concurrent startJob
      // calls for the same (prId, prHeadSha, mode, generationMode) can't race and produce
      // duplicate rows or zero rows.
      const result = yield* Effect.try({
        try: () =>
          db.transaction((tx): { id: string } => {
            let supersededExistingId: string | null = null;
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
                  eq(walkthroughs.mode, mode),
                  eq(walkthroughs.generationMode, generationMode),
                  ne(walkthroughs.status, "superseded"),
                ),
              )
              .get();

            if (existing) {
              if (existing.status === "generating") {
                // In-flight — keep the row. The orchestrator's
                // idempotent-startJob path upstream of this call already
                // handles this case; we only reach here on a race.
                return { id: existing.id };
              }
              if (existing.status === "complete" && !params.forceNew) {
                return { id: existing.id };
              }
              if (existing.status === "error" || existing.status === "complete") {
                tx.update(walkthroughs)
                  .set({ status: "superseded" })
                  .where(eq(walkthroughs.id, existing.id))
                  .run();
                supersededExistingId = existing.id;
                tx.update(reviewRounds)
                  .set({ status: "superseded" })
                  .where(eq(reviewRounds.walkthroughId, existing.id))
                  .run();
              }
              // 'superseded' rows stay in place now that uniqueness only
              // applies to active rows.
            }

            tx.insert(walkthroughs)
              .values({
                id: newId,
                reviewSessionId: params.reviewSessionId,
                pullRequestId: params.prId,
                summary: "",
                mode,
                riskLevel: "low",
                sentiment: null,
                status: "generating",
                lastCompletedPhase: "none",
                generatedAt,
                modelUsed: params.modelUsed,
                tokenUsage: "{}",
                prHeadSha: params.prHeadSha,
                generationMode,
                parentWalkthroughId: params.parentWalkthroughId ?? null,
                baseHeadSha: params.baseHeadSha ?? null,
                resumeAttempts: 0,
                prCommits: params.prCommits ? JSON.stringify(params.prCommits) : null,
                generatedByGithubUserId: params.generatedBy?.githubUserId ?? null,
                generatedByGithubLogin: params.generatedBy?.githubLogin ?? null,
                generatedByDisplayName: params.generatedBy?.displayName ?? null,
                generatedByAvatarUrl: params.generatedBy?.avatarContent ?? null,
                providerConfig: params.providerConfig
                  ? JSON.stringify(params.providerConfig)
                  : null,
              })
              .run();
            if (supersededExistingId) {
              tx.update(walkthroughs)
                .set({ supersededBy: newId })
                .where(eq(walkthroughs.id, supersededExistingId))
                .run();
            }
            const latestRound = tx
              .select({ roundNumber: reviewRounds.roundNumber })
              .from(reviewRounds)
              .where(eq(reviewRounds.pullRequestId, params.prId))
              .orderBy(desc(reviewRounds.roundNumber))
              .get();
            tx.insert(reviewRounds)
              .values({
                id: crypto.randomUUID(),
                pullRequestId: params.prId,
                reviewSessionId: params.reviewSessionId,
                walkthroughId: newId,
                previousWalkthroughId: params.parentWalkthroughId ?? null,
                roundNumber: (latestRound?.roundNumber ?? 0) + 1,
                kind: generationMode,
                visibility: "visible",
                status: "generating",
                fromSha: params.baseHeadSha ?? null,
                toSha: params.prHeadSha,
                createdAt: generatedAt,
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
      db.update(reviewRounds)
        .set({
          status,
          ...(status === "complete" ? { completedAt: new Date().toISOString() } : {}),
        })
        .where(eq(reviewRounds.walkthroughId, walkthroughId))
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
        db.update(reviewRounds)
          .set({ status: "superseded" })
          .where(eq(reviewRounds.walkthroughId, oldId))
          .run();
      });
    }).pipe(Effect.catchAll(() => Effect.void)),

  supersedeAllForPr: (prId, exceptHeadSha, mode) =>
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
          ...(mode ? [eq(walkthroughs.mode, mode)] : []),
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
        db.update(reviewRounds)
          .set({ status: "superseded" })
          .where(inArray(reviewRounds.walkthroughId, activeIds))
          .run();
      });
    }).pipe(Effect.catchAll(() => Effect.void)),

  getCached: (prId, headSha, mode = "reviewer") =>
    Effect.gen(function* () {
      const { db } = yield* DbService;

      const result = db
        .select({ wt: walkthroughs, avatarContent: remoteUsers.avatarContent })
        .from(walkthroughs)
        .leftJoin(
          remoteUsers,
          and(
            eq(remoteUsers.provider, "github"),
            eq(remoteUsers.login, walkthroughs.generatedByGithubLogin),
          ),
        )
        .where(
          and(
            eq(walkthroughs.pullRequestId, prId),
            eq(walkthroughs.prHeadSha, headSha),
            eq(walkthroughs.mode, mode),
            eq(walkthroughs.status, "complete"),
          ),
        )
        .get();

      if (!result) return null;

      const { wt: row, avatarContent } = result;

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

      return rowToWalkthrough(row, semanticSteps, blocks, issues, ratings, avatarContent);
    }),

  getPartial: (prId, headSha, mode = "reviewer") =>
    Effect.gen(function* () {
      const { db } = yield* DbService;

      // "Partial" = not yet 'complete' and not 'superseded'. Superseded
      // rows are terminal from a resume perspective — their head_sha is
      // stale and their supersededBy target is the active one.
      const result = db
        .select({ wt: walkthroughs, avatarContent: remoteUsers.avatarContent })
        .from(walkthroughs)
        .leftJoin(
          remoteUsers,
          and(
            eq(remoteUsers.provider, "github"),
            eq(remoteUsers.login, walkthroughs.generatedByGithubLogin),
          ),
        )
        .where(
          and(
            eq(walkthroughs.pullRequestId, prId),
            eq(walkthroughs.prHeadSha, headSha),
            eq(walkthroughs.mode, mode),
            ne(walkthroughs.status, "complete"),
            ne(walkthroughs.status, "superseded"),
          ),
        )
        .get();

      if (!result) return null;

      const { wt: row, avatarContent } = result;

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
        ...rowToWalkthrough(row, semanticSteps, blocks, issues, ratings, avatarContent),
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
          mode: walkthroughs.mode,
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
        mode: r.mode as WalkthroughMode,
        opencodeSessionId: r.opencodeSessionId ?? null,
        resumeAttempts: r.resumeAttempts,
      }));
    }),

  findResumable: (prId, mode) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = db
        .select({
          id: walkthroughs.id,
          pullRequestId: walkthroughs.pullRequestId,
          prHeadSha: walkthroughs.prHeadSha,
          mode: walkthroughs.mode,
          status: walkthroughs.status,
        })
        .from(walkthroughs)
        .where(
          and(
            eq(walkthroughs.pullRequestId, prId),
            ...(mode ? [eq(walkthroughs.mode, mode)] : []),
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
        mode: row.mode as WalkthroughMode,
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

  findLatestReviewArtifact: (prId) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const row = db
        .select({
          id: walkthroughs.id,
          prHeadSha: walkthroughs.prHeadSha,
        })
        .from(walkthroughs)
        .where(
          and(
            eq(walkthroughs.pullRequestId, prId),
            inArray(walkthroughs.status, ["complete", "superseded"]),
          ),
        )
        .orderBy(desc(walkthroughs.generatedAt))
        .get();
      return row ?? null;
    }).pipe(Effect.catchAll(() => Effect.succeed(null))),

  getLatestDisplayable: (prId, mode = "reviewer") =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const result = db
        .select({ wt: walkthroughs, avatarContent: remoteUsers.avatarContent })
        .from(walkthroughs)
        .leftJoin(
          remoteUsers,
          and(
            eq(remoteUsers.provider, "github"),
            eq(remoteUsers.login, walkthroughs.generatedByGithubLogin),
          ),
        )
        .where(
          and(
            eq(walkthroughs.pullRequestId, prId),
            eq(walkthroughs.mode, mode),
            inArray(walkthroughs.status, ["complete", "superseded"]),
          ),
        )
        .orderBy(desc(walkthroughs.generatedAt))
        .get();

      if (!result) return null;

      const { wt: row, avatarContent } = result;

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

      return rowToWalkthrough(row, semanticSteps, blocks, issues, ratings, avatarContent);
    }).pipe(Effect.catchAll(() => Effect.succeed(null))),

  getReport: (prId, walkthroughId, mode = "reviewer") =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const result = db
        .select({ wt: walkthroughs, avatarContent: remoteUsers.avatarContent })
        .from(walkthroughs)
        .leftJoin(
          remoteUsers,
          and(
            eq(remoteUsers.provider, "github"),
            eq(remoteUsers.login, walkthroughs.generatedByGithubLogin),
          ),
        )
        .where(
          and(
            eq(walkthroughs.id, walkthroughId),
            eq(walkthroughs.pullRequestId, prId),
            eq(walkthroughs.mode, mode),
          ),
        )
        .get();

      if (!result) return null;

      const { wt: row, avatarContent } = result;

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
        walkthrough: rowToWalkthrough(row, semanticSteps, blocks, issues, ratings, avatarContent),
        status: row.status as WalkthroughStatus,
      };
    }).pipe(Effect.catchAll(() => Effect.succeed(null))),

  listReviewRounds: (prId, currentHeadSha, fallbackCommits = [], mode = "reviewer") =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const rows = db
        .select({
          id: reviewRounds.id,
          walkthroughId: reviewRounds.walkthroughId,
          previousWalkthroughId: reviewRounds.previousWalkthroughId,
          roundNumber: reviewRounds.roundNumber,
          kind: reviewRounds.kind,
          visibility: reviewRounds.visibility,
          status: reviewRounds.status,
          fromSha: reviewRounds.fromSha,
          toSha: reviewRounds.toSha,
          createdAt: reviewRounds.createdAt,
          completedAt: reviewRounds.completedAt,
          summary: walkthroughs.summary,
          prCommits: walkthroughs.prCommits,
          prHeadSha: walkthroughs.prHeadSha,
        })
        .from(reviewRounds)
        .innerJoin(walkthroughs, eq(walkthroughs.id, reviewRounds.walkthroughId))
        .where(and(eq(reviewRounds.pullRequestId, prId), eq(walkthroughs.mode, mode)))
        .orderBy(asc(reviewRounds.roundNumber))
        .all();

      let rounds: WalkthroughReviewRound[] = rows.map((row) => ({
        id: row.id,
        walkthroughId: row.walkthroughId,
        previousWalkthroughId: row.previousWalkthroughId ?? null,
        roundNumber: row.roundNumber,
        kind: row.kind === "incremental" ? "incremental" : "full",
        visibility:
          row.visibility === "hidden" || (row.kind === "incremental" && row.fromSha === row.toSha)
            ? "hidden"
            : "visible",
        status: row.status as WalkthroughStatus,
        fromSha: row.fromSha ?? null,
        toSha: row.toSha,
        createdAt: row.createdAt,
        completedAt: row.completedAt ?? null,
        summary: row.summary.trim() ? row.summary : null,
        focusTitle: deriveRoundFocusTitle(
          row.prCommits,
          row.fromSha ?? null,
          row.toSha,
          fallbackCommits,
        ),
        prHeadSha: row.prHeadSha,
      }));

      if (rounds.length === 0) {
        const legacyRows = db
          .select({
            id: walkthroughs.id,
            previousWalkthroughId: walkthroughs.parentWalkthroughId,
            status: walkthroughs.status,
            generatedAt: walkthroughs.generatedAt,
            completedAt: walkthroughs.completedAt,
            summary: walkthroughs.summary,
            prCommits: walkthroughs.prCommits,
            prHeadSha: walkthroughs.prHeadSha,
            generationMode: walkthroughs.generationMode,
            baseHeadSha: walkthroughs.baseHeadSha,
          })
          .from(walkthroughs)
          .where(and(eq(walkthroughs.pullRequestId, prId), eq(walkthroughs.mode, mode)))
          .orderBy(asc(walkthroughs.generatedAt))
          .all();

        rounds = legacyRows.map((row, index) => ({
          id: `legacy-${row.id}`,
          walkthroughId: row.id,
          previousWalkthroughId: row.previousWalkthroughId ?? null,
          roundNumber: index + 1,
          kind: row.generationMode === "incremental" ? "incremental" : "full",
          visibility:
            row.generationMode === "incremental" && row.baseHeadSha === row.prHeadSha
              ? "hidden"
              : "visible",
          status: row.status as WalkthroughStatus,
          fromSha: row.baseHeadSha ?? null,
          toSha: row.prHeadSha,
          createdAt: row.generatedAt,
          completedAt: row.completedAt ?? null,
          summary: row.summary.trim() ? row.summary : null,
          focusTitle: deriveRoundFocusTitle(
            row.prCommits,
            row.baseHeadSha ?? null,
            row.prHeadSha,
            fallbackCommits,
          ),
          prHeadSha: row.prHeadSha,
        }));
      }

      const reportRounds = rounds.filter((round) => round.visibility !== "hidden");
      const latestReviewed =
        [...reportRounds].reverse().find((round) => round.completedAt !== null) ??
        [...reportRounds]
          .reverse()
          .find((round) => round.status === "complete" || round.status === "superseded") ??
        null;

      const latestReviewedHeadSha = latestReviewed?.toSha ?? null;
      const hasNewCommits =
        currentHeadSha !== null &&
        latestReviewedHeadSha !== null &&
        latestReviewedHeadSha !== currentHeadSha;

      return {
        prId,
        currentHeadSha,
        latestReviewedHeadSha,
        hasNewCommits,
        nextBaseHeadSha: hasNewCommits ? latestReviewedHeadSha : null,
        rounds,
      };
    }).pipe(
      Effect.catchAll(() =>
        Effect.succeed({
          prId,
          currentHeadSha,
          latestReviewedHeadSha: null,
          hasNewCommits: false,
          nextBaseHeadSha: null,
          rounds: [],
        }),
      ),
    ),

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
