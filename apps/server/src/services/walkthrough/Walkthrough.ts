// The walkthrough row's DB adapter: the orchestrator's lifecycle writes
// (invariants 2 and 11) and the read side. Content is written only by the MCP
// tool handlers; its codec lives in `walkthrough/content.ts`.

import type {
  RiskLevel,
  Walkthrough,
  WalkthroughEndReason,
  WalkthroughGenerationMode,
  WalkthroughIssue,
  WalkthroughMode,
  WalkthroughPipelinePhase,
  WalkthroughReviewRound,
  WalkthroughReviewRoundsResponse,
  WalkthroughStackSnapshot,
  WalkthroughStatus,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { and, asc, desc, eq, inArray, ne, type SQL } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Db } from "../../db";
import { account } from "../../db/schema/auth";
import { pullRequests } from "../../db/schema/pull-requests";
import { avatarOfPrLogin } from "../../db/schema/remote-users";
import { repositories } from "../../db/schema/repositories";
import { reviewRounds } from "../../db/schema/review-rounds";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import {
  type DiffFingerprint,
  type WalkthroughLaunchPlan,
  walkthroughs,
} from "../../db/schema/walkthroughs";
import type { DbError } from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import { DbService } from "../Db";
import type { PrCommit } from "../github/pulls";
import { Realtime } from "../Realtime";
import { type ThreadWrite, threadWrites } from "../Review";
import type { GeneratedBy, GenerationProviderConfig } from "./cache-format";
import {
  decodeBlock,
  decodeIssue,
  decodeProviderConfig,
  decodeRating,
  decodeSemanticStep,
  decodeTokenUsage,
  isRatedAxis,
  loadContentRows,
} from "./content";
import { loadWalkthroughLeads } from "./leads";
import { type RestackSource, restackSourceOf } from "./restack";
import { deriveRoundFocusTitle } from "./round-title";

function rowToWalkthrough(
  db: Db,
  row: typeof walkthroughs.$inferSelect,
  avatarContent: string | null,
): Walkthrough {
  const content = loadContentRows(db, row.id);
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
    semanticSteps: content.semanticSteps.map(decodeSemanticStep),
    blocks: content.blocks.flatMap((b) => decodeBlock(b) ?? []),
    issues: content.issues.map(decodeIssue),
    ratings: content.ratings.filter(isRatedAxis).map(decodeRating),
    leads: loadWalkthroughLeads(db, row.id, row.leadsSelectedAt),
    mode: (row.mode ?? "reviewer") as WalkthroughMode,
    lastCompletedPhase: row.lastCompletedPhase as WalkthroughPipelinePhase,
    errorMessage: row.errorMessage ?? null,
    endReason: row.endReason ?? null,
    riskLevel: row.riskLevel as RiskLevel,
    riskConfidence: row.riskConfidence,
    generatedAt: row.generatedAt,
    modelUsed: row.modelUsed,
    tokenUsage: decodeTokenUsage(row.tokenUsage),
    prHeadSha: row.prHeadSha,
    generationMode: row.generationMode as WalkthroughGenerationMode,
    parentWalkthroughId: row.parentWalkthroughId ?? null,
    baseHeadSha: row.baseHeadSha ?? null,
    generatedBy,
    providerConfig: decodeProviderConfig(row.providerConfig, row.modelUsed),
  };
}

function readWalkthrough(
  db: Db,
  where: SQL | undefined,
): { readonly walkthrough: Walkthrough; readonly status: WalkthroughStatus } | null {
  const found = db
    .select({
      row: walkthroughs,
      avatarContent: avatarOfPrLogin(
        walkthroughs.generatedByGithubLogin,
        walkthroughs.pullRequestId,
      ),
    })
    .from(walkthroughs)
    .where(where)
    .orderBy(desc(walkthroughs.generatedAt))
    .get();
  return found
    ? {
        walkthrough: rowToWalkthrough(db, found.row, found.avatarContent),
        status: found.row.status,
      }
    : null;
}

export class WalkthroughService extends Context.Service<
  WalkthroughService,
  {
    /**
     * Insert a fresh `generating` row at `(prId, prHeadSha, mode,
     * generationMode)` and open its review round. A row already active at
     * that key is superseded by it in the same transaction, with
     * `supersededBy` pointing at the new row: the orchestrator joins or
     * relaunches a live one before it ever asks for a new row. The model,
     * provider config and risk tier come later, from the launch it records
     * or the review it imports.
     */
    readonly createRow: (params: {
      reviewSessionId: string;
      prId: string;
      prHeadSha: string;
      mode: WalkthroughMode;
      generationMode: WalkthroughGenerationMode;
      parentWalkthroughId: string | null;
      baseHeadSha: string | null;
      /**
       * The PR's commits as `github.prs.commits` returns them, newest first.
       * The agent reads them through `get_commit_history` for the "How we
       * got here" chapter; a row without them reads as an empty history.
       */
      prCommits?: readonly PrCommit[];
      /** Who the review is attributed to. Travels with the snapshot to the team cache. */
      generatedBy?: GeneratedBy | null;
      stackContext?: WalkthroughStackSnapshot | null;
      diffFingerprint?: DiffFingerprint | null;
    }) => Effect.Effect<string, DbError>;

    /** The row active at `(prId, headSha, mode, generationMode)`, if any. */
    readonly activeAt: (
      prId: string,
      headSha: string,
      mode: WalkthroughMode,
      generationMode: WalkthroughGenerationMode,
    ) => Effect.Effect<
      { readonly id: string; readonly status: "generating" | "complete" | "error" } | null,
      DbError
    >;

    readonly getStackInputs: (walkthroughId: string) => Effect.Effect<
      {
        readonly stackContext: WalkthroughStackSnapshot | null;
        readonly diffFingerprint: DiffFingerprint | null;
      } | null,
      DbError
    >;

    /**
     * The review a restack could carry to `headSha`: this PR's newest row in
     * `mode` that finished all four phases at another head and recorded a
     * fingerprint. Null when a live row already exists at `headSha` (the
     * user's Regenerate on a carried review must reach the agent), or when
     * no such review exists. Whether its fingerprint matches is the caller's
     * call.
     */
    readonly findRestackSource: (
      prId: string,
      headSha: string,
      mode: WalkthroughMode,
    ) => Effect.Effect<RestackSource | null, DbError>;

    readonly markCarriedFrom: (
      walkthroughId: string,
      fromWalkthroughId: string,
    ) => Effect.Effect<void, DbError>;

    /**
     * End a run: `generating` → `complete` | `error`, with the review round
     * in step. A row that already left `generating` is untouched (false).
     * The ONLY caller is {@link WalkthroughJobs} (invariant #11).
     */
    readonly finish: (
      walkthroughId: string,
      status: "complete" | "error",
      options?: {
        tokenUsage?: WalkthroughTokenUsage;
        errorMessage?: string;
        endReason?: WalkthroughEndReason;
      },
    ) => Effect.Effect<boolean, DbError>;

    /**
     * A user's Resume of an `error` row: back to `generating` with a fresh
     * resume budget, keeping its content. False when the row isn't in `error`.
     */
    readonly revive: (walkthroughId: string) => Effect.Effect<boolean, DbError>;

    /**
     * Record the launch a row's runs use, and the model and provider config
     * it shows. With `risk`, the orchestrator-assigned tier (invariant 2's
     * carve-out), written in the same statement so no run starts without it.
     */
    readonly recordLaunch: (
      walkthroughId: string,
      plan: WalkthroughLaunchPlan,
      providerConfig: GenerationProviderConfig,
      risk?: { readonly level: RiskLevel; readonly confidence: number } | null,
    ) => Effect.Effect<void, DbError>;

    /**
     * Supersede every active walkthrough for a PR, leaving `supersededBy`
     * NULL: the row that replaces them doesn't exist yet (a head move retires
     * them before anyone asks for a review of the new head). Callers go
     * through {@link WalkthroughJobs.supersedeForPr}.
     *
     * `exceptHeadSha` spares rows at that head, so a walkthrough already
     * started at a just-detected new head isn't superseded by the poll that
     * observed the move.
     */
    readonly supersedeAllForPr: (
      prId: string,
      exceptHeadSha?: string,
      mode?: WalkthroughMode,
    ) => Effect.Effect<ReadonlyArray<string>, DbError>;

    readonly getCached: (
      prId: string,
      headSha: string,
      mode?: WalkthroughMode,
    ) => Effect.Effect<Walkthrough | null, DbError>;

    /**
     * The incomplete (generating/error) walkthrough at this head, for resume.
     * Superseded rows are terminal from the job's perspective and never returned.
     */
    readonly getPartial: (
      prId: string,
      headSha: string,
      mode?: WalkthroughMode,
      generationMode?: WalkthroughGenerationMode,
    ) => Effect.Effect<(Walkthrough & { status: "generating" | "error" }) | null, DbError>;

    /**
     * Rows still `generating`. On boot these are the ones a crash stranded,
     * for {@link WalkthroughJobs} to relaunch.
     */
    readonly listGenerating: () => Effect.Effect<
      Array<{
        readonly id: string;
        readonly pullRequestId: string;
        readonly prHeadSha: string;
        readonly mode: WalkthroughMode;
        readonly generationMode: WalkthroughGenerationMode;
        readonly resumeAttempts: number;
      }>,
      DbError
    >;

    /**
     * The PR's newest resumable walkthrough, for the manual-resume endpoint.
     *
     * Resumable = `status` is `'generating'` or `'error'`. The error case is
     * a user-driven retry: the orchestrator revives the row to `generating`,
     * resetting its retry counter and keeping its content, then relaunches it.
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
        readonly generationMode: WalkthroughGenerationMode;
        readonly status: "generating" | "error";
      } | null,
      DbError
    >;

    /** Bump the row's resume counter and return the new value. */
    readonly incrementResumeAttempts: (walkthroughId: string) => Effect.Effect<number, DbError>;

    /**
     * Stamp the given issues as posted to GitHub and return the timestamp.
     * Unknown ids are ignored: a regenerate may have wiped them between the
     * reviewer opening the tab and clicking Submit.
     */
    readonly markIssuesSubmitted: (issueIds: readonly string[]) => Effect.Effect<string, DbError>;

    /**
     * The PR's issues among `issueIds`, in that order. Ids that name no issue
     * of this PR are dropped: a regenerate may have wiped them.
     */
    readonly issuesOnPr: (
      prId: string,
      issueIds: readonly string[],
    ) => Effect.Effect<WalkthroughIssue[], DbError>;

    /**
     * Atomically take the next `seq` to stamp on an outgoing
     * `walkthrough:event` envelope (the pre-increment value, starting at 0).
     *
     * Survives `kill -9` and resume (invariant #1). Chat-edit writes after
     * `status='complete'` use the same counter, so it strictly grows for the
     * lifetime of the row.
     */
    readonly bumpSeq: (walkthroughId: string) => Effect.Effect<number, DbError>;

    /**
     * The `generating` walkthroughs on every account of the user, each with the cursor
     * (`seqAt = next_seq - 1`) the client uses to drop events that arrived on
     * the SSE before the snapshot. The client calls this once on SSE open to
     * seed sidebar spinners and `lastSeenSeq` cursors for jobs the user isn't
     * viewing.
     */
    readonly listActiveForUser: (userId: string) => Effect.Effect<
      Array<{
        readonly prId: string;
        readonly walkthroughId: string;
        readonly prHeadSha: string;
        readonly mode: WalkthroughMode;
        readonly seqAt: number;
      }>,
      DbError
    >;

    /**
     * The `seqAt = next_seq - 1` cursor a REST snapshot ships with, so the
     * client seeds `lastSeenSeq[walkthroughId]` and drops envelopes the
     * snapshot already covers.
     */
    readonly getSeqAt: (walkthroughId: string) => Effect.Effect<number, DbError>;

    /**
     * Find the latest completed/superseded walkthrough that can seed an
     * incremental refresh for a new PR head.
     */
    readonly findLatestReviewArtifact: (
      prId: string,
      mode?: WalkthroughMode,
    ) => Effect.Effect<
      {
        readonly id: string;
        readonly prHeadSha: string;
      } | null,
      DbError
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
    ) => Effect.Effect<Walkthrough | null, DbError>;

    /**
     * Return a specific walkthrough for a PR, whatever its perspective. This
     * is a read-only historical report view: callers use it to display an
     * older report, not to resume or mutate the row.
     */
    readonly getReport: (
      prId: string,
      walkthroughId: string,
    ) => Effect.Effect<
      { readonly walkthrough: Walkthrough; readonly status: WalkthroughStatus } | null,
      DbError
    >;

    /** The PR's review rounds across both perspectives (one is active at a
     *  time, so the history is a single timeline). */
    readonly listReviewRounds: (
      prId: string,
      currentHeadSha: string | null,
    ) => Effect.Effect<WalkthroughReviewRoundsResponse, DbError>;
  }
>()("WalkthroughService") {}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The one way a row becomes `superseded`: its AI comment threads are retired
 * (Submit would otherwise post a retired review's drafts; one already on
 * GitHub stays, detached), its review round follows, and a run cut off
 * mid-generation records why. Returns the thread writes, for the caller to
 * announce once committed.
 */
function supersedeRows(tx: Db | Tx, ids: readonly string[]): ThreadWrite<void>[] {
  if (ids.length === 0) return [];
  const issueIds = tx
    .select({ id: walkthroughIssues.id })
    .from(walkthroughIssues)
    .where(inArray(walkthroughIssues.walkthroughId, [...ids]))
    .all()
    .map((r) => r.id);
  const retired = threadWrites.retireAiThreads(tx, issueIds);
  tx.update(walkthroughs)
    .set({ status: "superseded", endReason: "superseded" })
    .where(and(inArray(walkthroughs.id, [...ids]), eq(walkthroughs.status, "generating")))
    .run();
  tx.update(walkthroughs)
    .set({ status: "superseded" })
    .where(and(inArray(walkthroughs.id, [...ids]), ne(walkthroughs.status, "superseded")))
    .run();
  tx.update(reviewRounds)
    .set({ status: "superseded" })
    .where(inArray(reviewRounds.walkthroughId, [...ids]))
    .run();
  return retired;
}

export const WalkthroughServiceLive = Layer.effect(
  WalkthroughService,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const realtime = yield* Realtime;
    const announceRetiredThreads = (writes: readonly ThreadWrite<void>[]) =>
      Effect.forEach(
        writes.flatMap((w) => w.envelopes.map((msg) => ({ prId: w.prId, msg }))),
        ({ prId, msg }) => realtime.toPr(prId, msg),
        { discard: true },
      );
    return WalkthroughService.of({
      createRow: (params) =>
        dbTry("create walkthrough", () =>
          db.transaction((tx) => {
            const id = crypto.randomUUID();
            const generatedAt = new Date().toISOString();
            const replaced = tx
              .select({ id: walkthroughs.id })
              .from(walkthroughs)
              .where(
                and(
                  eq(walkthroughs.pullRequestId, params.prId),
                  eq(walkthroughs.prHeadSha, params.prHeadSha),
                  eq(walkthroughs.mode, params.mode),
                  eq(walkthroughs.generationMode, params.generationMode),
                  ne(walkthroughs.status, "superseded"),
                ),
              )
              .all()
              .map((r) => r.id);
            const retiredThreads = supersedeRows(tx, replaced);

            tx.insert(walkthroughs)
              .values({
                id,
                reviewSessionId: params.reviewSessionId,
                pullRequestId: params.prId,
                summary: "",
                mode: params.mode,
                sentiment: null,
                status: "generating",
                lastCompletedPhase: "none",
                generatedAt,
                modelUsed: "",
                tokenUsage: "{}",
                prHeadSha: params.prHeadSha,
                generationMode: params.generationMode,
                parentWalkthroughId: params.parentWalkthroughId,
                baseHeadSha: params.baseHeadSha,
                resumeAttempts: 0,
                prCommits: params.prCommits ? JSON.stringify(params.prCommits) : null,
                stackContext: params.stackContext ?? null,
                diffFingerprint: params.diffFingerprint ?? null,
                generatedByGithubUserId: params.generatedBy?.githubUserId ?? null,
                generatedByGithubLogin: params.generatedBy?.githubLogin ?? null,
                generatedByDisplayName: params.generatedBy?.displayName ?? null,
                generatedByAvatarContent: params.generatedBy?.avatarContent ?? null,
              })
              .run();
            if (replaced.length > 0) {
              tx.update(walkthroughs)
                .set({ supersededBy: id })
                .where(inArray(walkthroughs.id, replaced))
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
                walkthroughId: id,
                previousWalkthroughId: params.parentWalkthroughId,
                roundNumber: (latestRound?.roundNumber ?? 0) + 1,
                kind: params.generationMode,
                visibility: "visible",
                status: "generating",
                fromSha: params.baseHeadSha,
                toSha: params.prHeadSha,
                createdAt: generatedAt,
              })
              .run();
            return { id, retiredThreads };
          }),
        ).pipe(
          Effect.tap(({ retiredThreads }) => announceRetiredThreads(retiredThreads)),
          Effect.map(({ id }) => id),
        ),

      activeAt: (prId, headSha, mode, generationMode) =>
        dbTry("activeAt", () => {
          const row = db
            .select({ id: walkthroughs.id, status: walkthroughs.status })
            .from(walkthroughs)
            .where(
              and(
                eq(walkthroughs.pullRequestId, prId),
                eq(walkthroughs.prHeadSha, headSha),
                eq(walkthroughs.mode, mode),
                eq(walkthroughs.generationMode, generationMode),
                ne(walkthroughs.status, "superseded"),
              ),
            )
            .get();
          return row && row.status !== "superseded" ? { id: row.id, status: row.status } : null;
        }),

      finish: (walkthroughId, status, options) =>
        dbTry("finish", () =>
          db.transaction(() => {
            // The canonical "walkthrough finished" timestamp the recap pipeline
            // windows on, distinct from `generatedAt` (job start). Kept through a
            // later supersede.
            const completedAt = status === "complete" ? new Date().toISOString() : null;
            const moved = db
              .update(walkthroughs)
              .set({
                status,
                errorMessage: status === "error" ? (options?.errorMessage ?? null) : null,
                endReason: status === "error" ? (options?.endReason ?? null) : null,
                ...(completedAt ? { completedAt } : {}),
                ...(options?.tokenUsage ? { tokenUsage: JSON.stringify(options.tokenUsage) } : {}),
              })
              .where(and(eq(walkthroughs.id, walkthroughId), eq(walkthroughs.status, "generating")))
              .returning({ id: walkthroughs.id })
              .all();
            if (moved.length === 0) return false;
            db.update(reviewRounds)
              .set({ status, ...(completedAt ? { completedAt } : {}) })
              .where(eq(reviewRounds.walkthroughId, walkthroughId))
              .run();
            return true;
          }),
        ),

      revive: (walkthroughId) =>
        dbTry("revive", () =>
          db.transaction(() => {
            const moved = db
              .update(walkthroughs)
              .set({ status: "generating", errorMessage: null, endReason: null, resumeAttempts: 0 })
              .where(and(eq(walkthroughs.id, walkthroughId), eq(walkthroughs.status, "error")))
              .returning({ id: walkthroughs.id })
              .all();
            if (moved.length === 0) return false;
            db.update(reviewRounds)
              .set({ status: "generating" })
              .where(eq(reviewRounds.walkthroughId, walkthroughId))
              .run();
            return true;
          }),
        ),

      recordLaunch: (walkthroughId, plan, providerConfig, risk) =>
        dbTry("recordLaunch", () => {
          db.update(walkthroughs)
            .set({
              launchPlan: plan,
              modelUsed: plan.model,
              providerConfig: JSON.stringify(providerConfig),
              ...(risk ? { riskLevel: risk.level, riskConfidence: risk.confidence } : {}),
            })
            .where(eq(walkthroughs.id, walkthroughId))
            .run();
        }),

      supersedeAllForPr: (prId, exceptHeadSha, mode) =>
        dbTry("supersedeAllForPr", () =>
          db.transaction((tx) => {
            const baseConditions = [
              eq(walkthroughs.pullRequestId, prId),
              ne(walkthroughs.status, "superseded"),
              ...(mode ? [eq(walkthroughs.mode, mode)] : []),
            ];
            const condition =
              exceptHeadSha !== undefined
                ? and(...baseConditions, ne(walkthroughs.prHeadSha, exceptHeadSha))
                : and(...baseConditions);

            const activeIds = tx
              .select({ id: walkthroughs.id })
              .from(walkthroughs)
              .where(condition)
              .all()
              .map((r) => r.id);

            return { activeIds, retiredThreads: supersedeRows(tx, activeIds) };
          }),
        ).pipe(
          Effect.tap(({ retiredThreads }) => announceRetiredThreads(retiredThreads)),
          Effect.map(({ activeIds }) => activeIds),
        ),

      getCached: (prId, headSha, mode = "reviewer") =>
        dbTry(
          "getCached",
          () =>
            readWalkthrough(
              db,
              and(
                eq(walkthroughs.pullRequestId, prId),
                eq(walkthroughs.prHeadSha, headSha),
                eq(walkthroughs.mode, mode),
                eq(walkthroughs.status, "complete"),
              ),
            )?.walkthrough ?? null,
        ),

      getPartial: (prId, headSha, mode = "reviewer", generationMode) =>
        dbTry("getPartial", () => {
          const found = readWalkthrough(
            db,
            and(
              eq(walkthroughs.pullRequestId, prId),
              eq(walkthroughs.prHeadSha, headSha),
              eq(walkthroughs.mode, mode),
              ...(generationMode ? [eq(walkthroughs.generationMode, generationMode)] : []),
              ne(walkthroughs.status, "complete"),
              ne(walkthroughs.status, "superseded"),
            ),
          );
          return found
            ? { ...found.walkthrough, status: found.status as "generating" | "error" }
            : null;
        }),

      getStackInputs: (walkthroughId) =>
        Effect.gen(function* () {
          const row = yield* dbTry("getStackInputs", () =>
            db
              .select({
                stackContext: walkthroughs.stackContext,
                diffFingerprint: walkthroughs.diffFingerprint,
              })
              .from(walkthroughs)
              .where(eq(walkthroughs.id, walkthroughId))
              .get(),
          );
          return row ?? null;
        }),

      findRestackSource: (prId, headSha, mode) =>
        dbTry("findRestackSource", () => restackSourceOf(db, prId, headSha, mode)),

      markCarriedFrom: (walkthroughId, fromWalkthroughId) =>
        Effect.gen(function* () {
          yield* dbTry("markCarriedFrom", () =>
            db
              .update(walkthroughs)
              .set({ carriedFromWalkthroughId: fromWalkthroughId })
              .where(eq(walkthroughs.id, walkthroughId))
              .run(),
          );
        }),

      listGenerating: () =>
        dbTry("listGenerating", () => {
          const rows = db
            .select({
              id: walkthroughs.id,
              pullRequestId: walkthroughs.pullRequestId,
              prHeadSha: walkthroughs.prHeadSha,
              mode: walkthroughs.mode,
              generationMode: walkthroughs.generationMode,
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
            generationMode: r.generationMode as WalkthroughGenerationMode,
            resumeAttempts: r.resumeAttempts,
          }));
        }),

      findResumable: (prId, mode) =>
        dbTry("findResumable", () => {
          const row = db
            .select({
              id: walkthroughs.id,
              pullRequestId: walkthroughs.pullRequestId,
              prHeadSha: walkthroughs.prHeadSha,
              mode: walkthroughs.mode,
              generationMode: walkthroughs.generationMode,
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
            generationMode: row.generationMode as WalkthroughGenerationMode,
            status: row.status as "generating" | "error",
          };
        }),

      incrementResumeAttempts: (walkthroughId) =>
        dbTry("incrementResumeAttempts", () => {
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
        }),

      markIssuesSubmitted: (issueIds) =>
        dbTry("markIssuesSubmitted", () => {
          const submittedAt = new Date().toISOString();
          if (issueIds.length === 0) return submittedAt;
          db.update(walkthroughIssues)
            .set({ submittedAt })
            .where(inArray(walkthroughIssues.id, [...issueIds]))
            .run();
          return submittedAt;
        }),

      issuesOnPr: (prId, issueIds) =>
        dbTry("issuesOnPr", () => {
          if (issueIds.length === 0) return [];
          const rows = db
            .select({ issue: walkthroughIssues })
            .from(walkthroughIssues)
            .innerJoin(walkthroughs, eq(walkthroughs.id, walkthroughIssues.walkthroughId))
            .where(
              and(
                inArray(walkthroughIssues.id, [...issueIds]),
                eq(walkthroughs.pullRequestId, prId),
              ),
            )
            .all();
          const byId = new Map(rows.map(({ issue }) => [issue.id, decodeIssue(issue)]));
          return issueIds.flatMap((id) => byId.get(id) ?? []);
        }),

      bumpSeq: (walkthroughId) =>
        dbTry("bumpSeq", () => {
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
        }),

      listActiveForUser: (userId) =>
        dbTry("listActiveForUser", () => {
          const rows = db
            .select({
              walkthroughId: walkthroughs.id,
              prId: walkthroughs.pullRequestId,
              prHeadSha: walkthroughs.prHeadSha,
              mode: walkthroughs.mode,
              nextSeq: walkthroughs.nextSeq,
            })
            .from(walkthroughs)
            .innerJoin(pullRequests, eq(pullRequests.id, walkthroughs.pullRequestId))
            .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
            .innerJoin(account, eq(account.id, repositories.accountId))
            .where(and(eq(walkthroughs.status, "generating"), eq(account.userId, userId)))
            .all();
          return rows.map((r) => ({
            prId: r.prId,
            walkthroughId: r.walkthroughId,
            prHeadSha: r.prHeadSha,
            mode: r.mode,
            seqAt: Math.max(0, r.nextSeq - 1),
          }));
        }),

      getSeqAt: (walkthroughId) =>
        dbTry("getSeqAt", () => {
          const row = db
            .select({ nextSeq: walkthroughs.nextSeq })
            .from(walkthroughs)
            .where(eq(walkthroughs.id, walkthroughId))
            .get();
          return Math.max(0, (row?.nextSeq ?? 1) - 1);
        }),

      findLatestReviewArtifact: (prId, mode = "reviewer") =>
        dbTry("findLatestReviewArtifact", () => {
          // Phase A's `set_overview` is the pipeline's first write, so a row still
          // at 'none' reviewed nothing. Rows die there when a supersede sweep
          // cancels them mid-exploration; taking one as the base would make the
          // next incremental run review an empty commit range.
          const reviewed = [
            eq(walkthroughs.mode, mode),
            inArray(walkthroughs.status, ["complete", "superseded"]),
            ne(walkthroughs.lastCompletedPhase, "none"),
          ];
          const roundRows = db
            .select({
              id: walkthroughs.id,
              prHeadSha: walkthroughs.prHeadSha,
              kind: reviewRounds.kind,
              visibility: reviewRounds.visibility,
              fromSha: reviewRounds.fromSha,
              toSha: reviewRounds.toSha,
            })
            .from(reviewRounds)
            .innerJoin(walkthroughs, eq(walkthroughs.id, reviewRounds.walkthroughId))
            .where(and(eq(reviewRounds.pullRequestId, prId), ...reviewed))
            .orderBy(desc(reviewRounds.roundNumber))
            .all();

          const visibleRound = roundRows.find(
            (row) =>
              row.visibility !== "hidden" &&
              !(row.kind === "incremental" && row.fromSha === row.toSha),
          );
          if (visibleRound) {
            return {
              id: visibleRound.id,
              prHeadSha: visibleRound.prHeadSha,
            };
          }

          const row = db
            .select({
              id: walkthroughs.id,
              prHeadSha: walkthroughs.prHeadSha,
            })
            .from(walkthroughs)
            .where(and(eq(walkthroughs.pullRequestId, prId), ...reviewed))
            .orderBy(desc(walkthroughs.generatedAt))
            .get();
          return row ?? null;
        }),

      getLatestDisplayable: (prId, mode = "reviewer") =>
        dbTry(
          "getLatestDisplayable",
          () =>
            readWalkthrough(
              db,
              and(
                eq(walkthroughs.pullRequestId, prId),
                eq(walkthroughs.mode, mode),
                inArray(walkthroughs.status, ["complete", "superseded"]),
              ),
            )?.walkthrough ?? null,
        ),

      getReport: (prId, walkthroughId) =>
        dbTry("getReport", () =>
          readWalkthrough(
            db,
            and(eq(walkthroughs.id, walkthroughId), eq(walkthroughs.pullRequestId, prId)),
          ),
        ),

      listReviewRounds: (prId, currentHeadSha) =>
        dbTry("listReviewRounds", () => {
          const rows = db
            .select({
              id: reviewRounds.id,
              walkthroughId: reviewRounds.walkthroughId,
              previousWalkthroughId: reviewRounds.previousWalkthroughId,
              roundNumber: reviewRounds.roundNumber,
              kind: reviewRounds.kind,
              mode: walkthroughs.mode,
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
            .where(eq(reviewRounds.pullRequestId, prId))
            .orderBy(asc(reviewRounds.roundNumber))
            .all();

          let rounds: WalkthroughReviewRound[] = rows.map((row) => ({
            id: row.id,
            walkthroughId: row.walkthroughId,
            previousWalkthroughId: row.previousWalkthroughId ?? null,
            roundNumber: row.roundNumber,
            kind: row.kind === "incremental" ? "incremental" : "full",
            mode: row.mode,
            visibility:
              row.visibility === "hidden" ||
              (row.kind === "incremental" && row.fromSha === row.toSha)
                ? "hidden"
                : "visible",
            status: row.status as WalkthroughStatus,
            fromSha: row.fromSha ?? null,
            toSha: row.toSha,
            createdAt: row.createdAt,
            completedAt: row.completedAt ?? null,
            summary: row.summary.trim() ? row.summary : null,
            focusTitle: deriveRoundFocusTitle(row.prCommits, row.fromSha ?? null, row.toSha),
            prHeadSha: row.prHeadSha,
          }));

          // legacy-upgrade: walkthroughOnlyReviewRounds.
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
                mode: walkthroughs.mode,
                baseHeadSha: walkthroughs.baseHeadSha,
              })
              .from(walkthroughs)
              .where(eq(walkthroughs.pullRequestId, prId))
              .orderBy(asc(walkthroughs.generatedAt))
              .all();

            rounds = legacyRows.map((row, index) => ({
              id: `legacy-${row.id}`,
              walkthroughId: row.id,
              previousWalkthroughId: row.previousWalkthroughId ?? null,
              roundNumber: index + 1,
              kind: row.generationMode === "incremental" ? "incremental" : "full",
              mode: row.mode,
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
        }),
    });
  }),
);
