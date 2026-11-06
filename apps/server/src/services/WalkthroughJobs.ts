// ── WalkthroughJobs ────────────────────────────────────────────────────────
// Durable, isolated AI walkthrough generator — ORCHESTRATOR only (doctrine
// invariants #2, #11). Owns:
//
//   • An in-memory registry of running fibers keyed by walkthroughId. Purely
//     ephemeral coordination — the DB is the source of truth (invariant #1).
//   • A shared Semaphore (capacity = MAX_CONCURRENT_JOBS) so a burst of
//     "Regenerate" clicks can't spawn unlimited parallel agent turns.
//   • Per-job AbortController, wired into the ACP driver so cancellation
//     propagates into the agent's turn.
//   • Per-job scope with a detached `git worktree` pinned at prHeadSha.
//   • Per-job opaque session token — the HTTP MCP route authenticates the
//     agent's tool calls against it before dispatching to the shared handlers
//     (see apps/server/src/routes/mcp/walkthrough.ts).
//   • `setStatus` — the SOLE writer of the walkthroughs.status column.
//     Every other module that needs to transition a walkthrough's lifecycle
//     goes through this chokepoint (invariant #11).
//   • `supersedeForPr` — called by PollScheduler when a PR's head SHA
//     changes. Marks the old rows `'superseded'` (invariant #7). Never
//     mutates in place.
//
// Content writes are NOT here. The agent's MCP tool handlers in
// walkthrough-tools own all content persistence (blocks, issues, ratings,
// summary, sentiment). This service observes the driver stream ONLY to
// broadcast it and to react at lifecycle boundaries — `done` (generator end)
// triggers validation + setStatus; `error` triggers setStatus('error')
// (doctrine invariant #2).

import {
  REVIEW_MODE,
  type RiskLevel,
  type StartJobTrigger,
  type Walkthrough,
  type WalkthroughGenerationMode,
  type WalkthroughMode,
  type WalkthroughStackSnapshot,
  type WalkthroughStatus,
  type WalkthroughStreamEvent,
  type WalkthroughTokenUsage,
} from "@revv/shared";
import { SPAN } from "@revv/shared/telemetry";
import { eq } from "drizzle-orm";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  type Scope,
  Semaphore,
} from "effect";
import { type ActivityBeacon, JOB_TURN, makeActivityBeacon } from "../ai/acp/run-turn";
import { adjudicateContinuation } from "../ai/jev/continuation";
import { resolveJobStart } from "../ai/jev/job-start-resolution";
import { awaitJudgments, forgetWalkthrough as forgetPendingJudgments } from "../ai/jev/pending";
import { forgetProse } from "../ai/jev/prose-voice";
import type { GenerationLaunchOverride } from "../ai/jev/routing";
import { withWalkthroughMetrics } from "../ai/providers/walkthrough-metrics";
import {
  accumulateTokenUsage,
  addThroughput,
  mergeContextOccupancy,
  ZERO_TOKEN_USAGE,
} from "../ai/providers/walkthrough-token-usage";
import { findIssuesMissingInlineComment } from "../ai/providers/walkthrough-tools";
import { pullRequests } from "../db/schema/pull-requests";
import { repositories } from "../db/schema/repositories";
import { type DiffFingerprint, walkthroughs } from "../db/schema/walkthroughs";
import {
  type AiError,
  AiGenerationError,
  type CloneError,
  CloneInProgressError,
  CloneNotReadyError,
  type DbError,
  type GitHubError,
  HeadShaMismatchError,
  type NotFoundError,
  type ValidationError,
} from "../domain/errors";
import { dbTry } from "../effects/db-try";
import { withDb } from "../effects/with-db";
import { debug, logError } from "../logger";
import { withGitHubOrigin } from "../observability/github-ledger/origin";
import { withTraceAnchor } from "../observability/span-graft";
import { AiService } from "./Ai";
import { CacheService } from "./Cache";
import { DbService } from "./Db";
import { GitHubEtagCache } from "./GitHubEtagCache";
import { HunkScanService } from "./HunkScan";
import { JevService } from "./Jev";
import { analyzeJobFailure } from "./job-failure";
import { makeStartJobMutex } from "./job-mutex";
import { PrContextService } from "./PrContext";
import { Realtime } from "./Realtime";
import { RemoteWalkthroughCache } from "./RemoteWalkthroughCache";
import { RepoCloneService } from "./RepoClone";
import { ReviewService } from "./Review";
import { SettingsService } from "./Settings";
import { makeSessionTokenStore } from "./session-token-store";
import { StackService } from "./stacks/StackService";
import { WalkthroughService } from "./Walkthrough";
import { WalkthroughSnapshotImporter } from "./WalkthroughSnapshotImporter";
import {
  tryCarryRestackedWalkthrough,
  tryImportCachedWalkthrough,
} from "./walkthrough-cache-import";
import {
  buildContinuationAdjudicationState,
  continuationCounts,
  finishWalkthroughAtBudgetEnd,
} from "./walkthrough-job-budget";
import { resolveWalkthroughLaunch, resolveWalkthroughOwner } from "./walkthrough-job-context";
import { leadsRecorded, prepareFirstPassLeads } from "./walkthrough-leads";
import { type PromptFile, resolveIncrementalPromptFiles } from "./walkthrough-prompt-files";
import { resolveStackInputs } from "./walkthrough-stack-inputs";

// ── Constants ────────────────────────────────────────────────────────────────

/** Cap on concurrent walkthrough fibers. Additional jobs queue on the semaphore. */
const MAX_CONCURRENT_JOBS = 5;

/**
 * Soft cap on how many times a single walkthrough row will be re-launched
 * across server restarts. After this many attempts the row is marked `error`
 * and no further resume fiber is spawned.
 */
const WALKTHROUGH_MAX_RESUME_ATTEMPTS = 3;

/**
 * Maximum number of automatic in-flight continuations when the AI generator
 * exits without reaching Phase D (all 9 axes rated). Capped to prevent
 * infinite loops if the model persistently fails.
 */
const MAX_AUTO_CONTINUATIONS = 2;

/**
 * Opaque session token TTL for the HTTP MCP route.
 * Derived from the turn ceiling so a token never expires mid-run:
 *   JOB_TURN.ceilingMs × (1 + MAX_AUTO_CONTINUATIONS) + 5 min margin.
 */
const SESSION_TOKEN_TTL_MS = JOB_TURN.ceilingMs * (1 + MAX_AUTO_CONTINUATIONS) + 5 * 60_000;

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Result of an emit attempt. `unsequenced`: the seq bump didn't commit, so
 * the event was not broadcast; clients reconcile from the DB (invariant #8).
 */
export type EmitResult =
  | { readonly kind: "delivered"; readonly seq: number }
  | { readonly kind: "unsequenced"; readonly walkthroughId: string };

interface ActiveJob {
  readonly walkthroughId: string;
  readonly prId: string;
  readonly prHeadSha: string;
  readonly mode: WalkthroughMode;
  readonly userId: string;
  /**
   * Better-auth `account.id` that owns the repo backing this PR. Resolved
   * once at `startJob` time so `emitEvent` can target `Realtime.broadcastToAccount`
   * without hitting the DB on every event. Empty string when the repo
   * lookup fails (rare — falls back to global broadcast).
   */
  readonly accountId: string;
  readonly abortController: AbortController;
  /**
   * Rearms the driver's idle deadline. Noted on every MCP call authenticated
   * against this job's token: proof the agent is alive that the ACP stream
   * doesn't carry (MCP tool calls decode to nothing there).
   */
  readonly activity: ActivityBeacon;
  fiber: Fiber.Fiber<unknown, unknown> | null;
  cancelledByUser: boolean;
  /**
   * Why the job was cancelled, or null if it ended on its own.
   *
   * Both reasons are deliberate — neither may be left for resume-on-boot —
   * but they differ on the wire: a `'user'` cancel is the terminal state the
   * reviewer sees and broadcasts `lifecycle:error`/'Cancelled', whereas a
   * `'superseded'` cancel is immediately followed by the sweep's own
   * `lifecycle:superseded`, so announcing an error first would flash a
   * spurious failure in the UI on every head move.
   */
  cancelReason: "user" | "superseded" | null;
}

/** `errorMessage` of a row whose run was cancelled (the user's Stop, or a supersede). */
export const WALKTHROUGH_CANCELLED_MESSAGE = "Walkthrough cancelled";

const isUserInitiated = (trigger: StartJobTrigger): boolean =>
  trigger === "user" || trigger === "external_agent" || trigger === "stack_review";

export interface StartJobParams {
  readonly prId: string;
  readonly userId: string;
  readonly trigger: StartJobTrigger;
  readonly walkthroughId?: string;
  readonly mode?: WalkthroughMode;
  readonly generationMode?: WalkthroughGenerationMode;
  /**
   * Review exactly this head or nothing. Checked under the per-PR lock
   * against the head GitHub serves — a mismatch fails with
   * `HeadShaMismatchError` before anything is cancelled — and, once it
   * matches, every other head's review in this mode is retired, as
   * PollScheduler would on its next tick: the PR is at this head, so they
   * are stale.
   */
  readonly expectedHeadSha?: string;
}

export interface StartJobResult {
  readonly walkthroughId: string;
  /** An in-flight job (or the row being resumed) was returned; nothing new launched. */
  readonly reused: boolean;
}

const otherWalkthroughMode = (mode: WalkthroughMode): WalkthroughMode =>
  mode === REVIEW_MODE.author ? REVIEW_MODE.reviewer : REVIEW_MODE.author;

/** Error union surfaced by `startJob`. Inherited from its transitive calls. */
export type StartJobError =
  | AiError
  | CloneError
  | CloneInProgressError
  | CloneNotReadyError
  | GitHubError
  | HeadShaMismatchError
  | NotFoundError
  | DbError
  | ValidationError;

// ── Service tag ──────────────────────────────────────────────────────────────

export class WalkthroughJobs extends Context.Service<
  WalkthroughJobs,
  {
    /**
     * Start (or attach to) a walkthrough generation job for a PR.
     *
     * Idempotent: the UNIQUE INDEX on (pullRequestId, prHeadSha) means a
     * concurrent duplicate start upserts onto the same row. The fast path
     * here also short-circuits when an in-memory job already exists.
     */
    readonly startJob: (params: StartJobParams) => Effect.Effect<StartJobResult, StartJobError>;

    /**
     * Probe the remote team cache for `(prId, headSha)` and, on a hit,
     * import + flip the row to `'complete'` — without starting the agent.
     * Returns `true` when a walkthrough was hydrated, `false` on miss or
     * any failure (failures are logged; never propagated to the caller).
     *
     * Meant for the `/current` route handler so the first page-load
     * immediately hydrates from the team cache rather than showing the
     * Generate button.
     */
    readonly tryHydrateFromRemoteCache: (
      prId: string,
      headSha: string,
      repoFullName: string,
      mode?: WalkthroughMode,
    ) => Effect.Effect<boolean>;

    readonly findActiveByPr: (
      prId: string,
      mode?: WalkthroughMode,
    ) => Effect.Effect<{ readonly walkthroughId: string; readonly prHeadSha: string } | null>;

    readonly cancel: (walkthroughId: string) => Effect.Effect<void>;

    /**
     * Revive a walkthrough row from `status='error'` back to `'generating'`
     * and reset the resume-attempt counter. Used by the user-driven resume
     * path so an errored row can pick up its partial content instead of
     * being recycled by `createPartial` (which drops `'error'` rows).
     *
     * Per doctrine invariant #11, status transitions are orchestrator-only;
     * this is the chokepoint for the error→generating transition. The
     * resume-attempt counter is bundled with the transition because the
     * user click signals fresh intent — the prior counter measured how
     * many *unattended* boot-time retries the row had survived, which is
     * no longer the right gate now that a human is asking explicitly.
     *
     * No-op if the row isn't in `'error'`.
     */
    readonly reviveFromError: (walkthroughId: string) => Effect.Effect<void, DbError>;

    readonly resumePending: () => Effect.Effect<void, DbError>;

    /**
     * Cancel any in-flight job for a PR and mark all existing walkthroughs
     * 'superseded'. Used when PollScheduler detects a head-SHA change —
     * the old work is frozen in place (immutable per SHA, invariant #7)
     * and the next user interaction triggers a fresh walkthrough for the
     * new SHA.
     *
     * `exceptHeadSha` (optional): when the caller knows what the new HEAD
     * SHA is, jobs whose `prHeadSha` already equals that value are NOT
     * cancelled. This protects the SSE-creates-walkthrough-then-poll-detects-
     * mismatch race: PollScheduler is asking us to invalidate "everything
     * stuck on the OLD sha", not "everything for this PR" — a freshly-
     * created walkthrough at the latest SHA is by definition not stale.
     * Regenerate (no exception passed) keeps its kill-everything semantics.
     */
    readonly supersedeForPr: (
      prId: string,
      exceptHeadSha?: string,
      mode?: WalkthroughMode,
    ) => Effect.Effect<void, DbError>;

    /**
     * Stamp an event with the walkthrough's durable seq and broadcast it on
     * the account's SSE bus. Callers commit to the DB first (invariant #8):
     * the orchestrator for lifecycle events, the MCP tool handlers for
     * content, chat-edit for post-completion edits.
     *
     * Returns whether the event was broadcast; see {@link EmitResult}.
     */
    readonly emitEvent: (
      walkthroughId: string,
      event: WalkthroughStreamEvent,
    ) => Effect.Effect<EmitResult>;

    /**
     * Issue an opaque session token for the HTTP MCP route. Tokens resolve
     * to a walkthroughId and are valid only while the job is running; the
     * job's scope clears them on exit.
     */
    readonly issueSessionToken: (walkthroughId: string) => Effect.Effect<string>;

    /**
     * Resolve a session token. Returns null if expired or unknown, or if
     * the job is no longer running. Used by the HTTP MCP route to
     * authenticate the agent's tool calls; a resolved token counts as agent
     * activity for the job's idle deadline.
     */
    readonly resolveSessionToken: (token: string) => Effect.Effect<{
      readonly walkthroughId: string;
      readonly prId: string;
      readonly accountId: string;
    } | null>;
  }
>()("WalkthroughJobs") {}

// ── Live implementation ──────────────────────────────────────────────────────

export const WalkthroughJobsLive = Layer.effect(
  WalkthroughJobs,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const etagCache = yield* GitHubEtagCache;
    const ai = yield* AiService;
    const prContextService = yield* PrContextService;
    const repoCloneService = yield* RepoCloneService;
    const reviewService = yield* ReviewService;
    const settingsService = yield* SettingsService;
    const walkthroughService = yield* WalkthroughService;
    const remoteCache = yield* RemoteWalkthroughCache;
    const jevService = yield* JevService;
    const hunkScanService = yield* HunkScanService;
    const cacheService = yield* CacheService;
    const snapshotImporter = yield* WalkthroughSnapshotImporter;
    const realtime = yield* Realtime;
    const stackService = yield* StackService;

    const registry = yield* Ref.make(new Map<string, ActiveJob>());
    const semaphore = yield* Semaphore.make(MAX_CONCURRENT_JOBS);

    // Per-PR mutex for `startJob`. Without this, two concurrent startJob
    // calls for the same prId can both pass the in-memory `findActiveByPr`
    // check and both call `launchJob`, which inserts into the registry by
    // `walkthroughId` (overwrites if the second call resolved to the same
    // id) and forks two daemon fibers. Both fibers acquire the global
    // MAX_CONCURRENT_JOBS semaphore permit, but only one is reachable from
    // the registry — `cancel` can only kill the one in the registry, so
    // the orphan keeps holding its permit until it terminates naturally.
    // After enough PR-switching with parallel walkthroughs the global
    // semaphore is exhausted and new jobs queue forever ("generation
    // stops"). The per-PR mutex serializes startJob calls for the same
    // PR so the registry/launchJob handoff is atomic; concurrent calls
    // for *different* PRs still run in parallel. Keyed by prId.
    const startJobMutex = yield* makeStartJobMutex();

    // Opaque-token → walkthroughId store. Ephemeral coordination (invariant #1):
    // tokens are never persisted; on restart they're regenerated by the resume
    // path. The HTTP MCP route resolves against this store. The injected
    // liveness predicate makes a token stop resolving the moment its job leaves
    // the registry (the job died), even before TTL expiry.
    const sessionStore = yield* makeSessionTokenStore<{ readonly walkthroughId: string }>(
      SESSION_TOKEN_TTL_MS,
      (payload) => Effect.map(Ref.get(registry), (map) => map.has(payload.walkthroughId)),
    );

    const provideInfra = <A, E>(
      eff: Effect.Effect<A, E, DbService | GitHubEtagCache | SettingsService>,
    ): Effect.Effect<A, E> =>
      eff.pipe(
        Effect.provideService(DbService, { db }),
        Effect.provideService(GitHubEtagCache, etagCache),
        Effect.provideService(SettingsService, settingsService),
      );

    const provideDb = <A, E>(eff: Effect.Effect<A, E, DbService>): Effect.Effect<A, E> =>
      withDb(db, eff);

    // ── Status chokepoint (invariant #11) ────────────────────────────────
    //
    // Every status transition goes through this single method. Agents never
    // write status; other services call this.
    const setStatus = (
      walkthroughId: string,
      status: WalkthroughStatus,
      options?: { tokenUsage?: WalkthroughTokenUsage; errorMessage?: string },
    ) =>
      Effect.withSpan(SPAN.walkthroughSetStatus, {
        attributes: { walkthroughId, status },
      })(
        provideDb(
          walkthroughService.setStatus(walkthroughId, status, {
            ...(options?.tokenUsage ? { tokenUsage: options.tokenUsage } : {}),
            ...(options?.errorMessage ? { errorMessage: options.errorMessage } : {}),
          }),
        ),
      );

    const removeJob = (walkthroughId: string) =>
      Effect.all(
        [
          Ref.update(registry, (map) => {
            if (!map.has(walkthroughId)) return map;
            const next = new Map(map);
            next.delete(walkthroughId);
            return next;
          }),
          // Per-run ephemeral bookkeeping (see `ai/jev/pending.ts`); dropped here
          // so a long-lived server doesn't accumulate a set per walkthrough.
          Effect.sync(() => {
            forgetPendingJudgments(walkthroughId);
            forgetProse(walkthroughId);
          }),
        ],
        { discard: true },
      );

    // ── Core job body ───────────────────────────────────────────────────

    type PartialSnapshot = Walkthrough & { readonly status: "generating" | "error" };

    type ResolvedContext = {
      readonly pr: {
        readonly id: string;
        readonly title: string;
        readonly body: string | null;
        readonly sourceBranch: string;
        readonly targetBranch: string;
        readonly url: string;
        readonly externalId: number;
      };
      readonly repoId: string;
      readonly token: string;
      readonly prHeadSha: string;
      readonly repoFullName: string;
      readonly githubHost: string;
      readonly files: ReadonlyArray<PromptFile>;
      readonly partial: PartialSnapshot | null;
      readonly reviewSessionId: string;
      readonly modelUsed: string;
      readonly mode: WalkthroughMode;
      readonly generationMode: WalkthroughGenerationMode;
      readonly parentWalkthroughId: string | null;
      readonly baseHeadSha: string | null;
      /**
       * Model/effort override from the TypeSafe depth answer, resolved once at
       * job start (not per-stream: `streamParams` is reused by
       * `buildContinuationEffect`, and a per-stream derivation would hand a
       * continuation a different ACP pool key, orphaning the first connection).
       */
      readonly launchOverride: GenerationLaunchOverride | null;
      /** Orchestrator-assigned risk tier; `null` means the agent judges the tier itself. */
      readonly assignedRisk: RiskLevel | null;
      /**
       * Changed files in orchestrator-scored attention order, or `null` when
       * unavailable. Threaded through the prompt, not the tool surface, since it
       * shapes the agent's plan before its first tool call.
       */
      readonly filePriorities: ReadonlyArray<{
        readonly filename: string;
        readonly tier: number | null;
      }> | null;
      /** Present when the PR was judged to carry several independent concerns. */
      readonly splitRecommendation: { readonly pieces: number } | null;
      /** Snapshotted at job start so a settings change mid-run can't flip behaviour halfway through a retry budget. */
      readonly adjudicateContinuations: boolean;
      readonly stack: WalkthroughStackSnapshot | null;
      readonly parentFingerprint: DiffFingerprint | null;
    };

    interface LoopState {
      // The full running snapshot: throughput accumulates across generators /
      // auto-continuations, while occupancy (contextTokens / contextWindowTokens)
      // tracks the latest call point-in-time. See `token-usage.ts` for the
      // accumulation semantics. Every exit path reads this directly.
      accumulatedTokenUsage: WalkthroughTokenUsage;
      autoContinuations: number;
      currentGenerator: AsyncGenerator<WalkthroughStreamEvent>;
      /** Wall-clock start, for the adjudication state. */
      readonly startedAt: number;
      /** Phase/counts as of the previous auto-continuation; without them "progress since" is undefined, so the first continuation is never adjudicated. */
      phaseAtLastContinuation: string | null;
      countsAtLastContinuation: Record<string, number> | null;
      /** Why the last generator stopped, for the failure classification. */
      terminalReason: string;
    }

    type ProcessResult =
      | { readonly _tag: "continue" }
      | { readonly _tag: "breakToContinuation" }
      | { readonly _tag: "returnDone"; readonly tokenUsage: WalkthroughTokenUsage }
      | { readonly _tag: "returnError"; readonly code: string; readonly message: string };

    const buildJobBody = (
      job: ActiveJob,
      ctx: ResolvedContext,
    ): Effect.Effect<void, AiError | DbError, Scope.Scope> =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (!job.abortController.signal.aborted) {
              debug("walkthrough-jobs", "scope closing — aborting AI controller");
              try {
                job.abortController.abort(new Error("Walkthrough job scope closed"));
              } catch {
                /* already aborted — ignore */
              }
            }
          }),
        );

        // The first pass runs alongside the worktree checkout, which hides most of
        // its latency. Usually the review page already started it for this head,
        // and this joins that run (or reads its result) — for at most
        // HUNK_SCAN_JOIN_BUDGET_MS, so a large or slow scan never holds Phase A.
        // A resume is prompted with the leads its first run recorded, so it
        // doesn't wait on the scan at all.
        const resumedLeads = yield* dbTry("leadsRecorded", () =>
          leadsRecorded(db, job.walkthroughId),
        ).pipe(Effect.orElseSucceed(() => false));
        const hunkScan = resumedLeads
          ? Effect.succeed([])
          : hunkScanService.run({
              prId: ctx.pr.id,
              headSha: ctx.prHeadSha,
              files: ctx.files,
              filePriorities: ctx.filePriorities,
            });
        const worktree = repoCloneService
          .acquirePrWorktree({
            repoId: ctx.repoId,
            prNumber: ctx.pr.externalId,
            prHeadSha: ctx.prHeadSha,
            githubToken: ctx.token,
            exactHead: true,
          })
          .pipe(
            Effect.mapError((e) => {
              const message =
                e._tag === "CloneNotReadyError"
                  ? `Repository clone is not ready — check Settings to ensure the repo is cloned`
                  : e._tag === "CloneError"
                    ? `Repository clone error: ${e.message}`
                    : String(e);
              return new AiGenerationError({ cause: e, message });
            }),
          );
        const [{ worktreePath }, hunkScanRows] = yield* Effect.all([worktree, hunkScan], {
          concurrency: 2,
        });

        const promptInput = yield* resolveIncrementalPromptFiles(ctx, worktreePath).pipe(
          Effect.tap((result) =>
            Effect.annotateCurrentSpan({
              diff_source: result.diffSource,
              files: result.files.length,
            }),
          ),
          Effect.withSpan("Walkthrough.resolveDiff"),
        );
        const hunkLeads = yield* prepareFirstPassLeads(
          db,
          job.walkthroughId,
          hunkScanRows,
          promptInput,
        );
        yield* emitEvent(job.walkthroughId, {
          type: "leads",
          data: { leads: hunkLeads },
        }).pipe(Effect.catch(() => Effect.void));

        // One token for the whole job, auto-continuations included; the scope
        // finalizer in `launchJob` clears it.
        const mcpToken = yield* issueSessionToken(job.walkthroughId);
        const streamParams = (resumed: boolean) => ({
          pr: {
            title: ctx.pr.title,
            body: ctx.pr.body,
            sourceBranch: ctx.pr.sourceBranch,
            targetBranch: ctx.pr.targetBranch,
            url: ctx.pr.url,
          },
          files: promptInput.files as never,
          mode: ctx.mode,
          worktreePath,
          walkthroughId: job.walkthroughId,
          reviewMode: {
            mode: ctx.generationMode,
            parentWalkthroughId: ctx.parentWalkthroughId,
            baseHeadSha: ctx.baseHeadSha,
            headSha: ctx.prHeadSha,
            diffSource: promptInput.diffSource,
          },
          resumed,
          ...(ctx.launchOverride ? { launchOverride: ctx.launchOverride } : {}),
          ...(ctx.assignedRisk ? { assignedRisk: ctx.assignedRisk } : {}),
          ...(ctx.filePriorities ? { filePriorities: ctx.filePriorities } : {}),
          ...(ctx.splitRecommendation ? { splitRecommendation: ctx.splitRecommendation } : {}),
          ...(hunkLeads.length > 0 ? { hunkLeads } : {}),
          ...(ctx.stack ? { stack: ctx.stack } : {}),
          mcpToken,
          activity: job.activity,
          abortController: job.abortController,
        });

        const generator = yield* ai.streamWalkthrough(streamParams(ctx.partial !== null));

        // ── Event loop ──────────────────────────────────────────────
        //
        // Content never passes through here: the MCP tool handlers persist
        // and broadcast it. This loop only:
        //   - Broadcasts the driver's live events (best effort, invariant #8).
        //   - Tracks token usage for auto-continuation + completion.
        //   - Reacts to the terminal `done` / `error` events.

        const closeGeneratorBestEffort = (
          generator: AsyncGenerator<WalkthroughStreamEvent>,
        ): Effect.Effect<void> =>
          Effect.sync(() => {
            void generator.return?.(undefined).catch((err) => {
              debug(
                "walkthrough-jobs",
                "generator cleanup failed:",
                err instanceof Error ? err.message : String(err),
              );
            });
          });

        const processEvent = (
          state: LoopState,
          event: WalkthroughStreamEvent,
        ): Effect.Effect<ProcessResult, DbError> =>
          Effect.gen(function* () {
            if (event.type === "done") {
              state.accumulatedTokenUsage = accumulateTokenUsage(
                state.accumulatedTokenUsage,
                event.data.tokenUsage,
              );
              const currentTokenUsage = state.accumulatedTokenUsage;

              yield* emitEvent(job.walkthroughId, {
                type: "usage",
                data: { tokenUsage: currentTokenUsage },
              }).pipe(Effect.catch(() => Effect.void));

              // Orchestrator is the lifecycle owner; validates a stable issue set independently before writing `complete`.
              yield* Effect.promise(() => awaitJudgments(job.walkthroughId));

              const dbState = yield* provideDb(
                walkthroughService.getPartial(
                  ctx.pr.id,
                  ctx.prHeadSha,
                  ctx.mode,
                  ctx.generationMode,
                ),
              ).pipe(Effect.catch(() => Effect.succeed(null)));

              if (dbState?.lastCompletedPhase === "D") {
                const missingComments = findIssuesMissingInlineComment(db, job.walkthroughId);
                if (missingComments.length === 0) {
                  yield* setStatus(job.walkthroughId, "complete", {
                    tokenUsage: currentTokenUsage,
                  });
                  // Fire-and-forget push to the team cache. Failures log
                  // inside the service and never block job completion
                  // (invariant #8 — commit first, broadcast second; the
                  // cache push is broadcast-equivalent).
                  if (job.mode === "reviewer") {
                    yield* Effect.forkDetach(
                      remoteCache.push(job.walkthroughId).pipe(Effect.catch(() => Effect.void)),
                    );
                  }
                  yield* emitEvent(job.walkthroughId, {
                    type: "lifecycle:complete",
                    data: {
                      walkthroughId: job.walkthroughId,
                      tokenUsage: currentTokenUsage,
                    },
                  }).pipe(Effect.catch(() => Effect.void));
                  return { _tag: "returnDone", tokenUsage: currentTokenUsage } as const;
                }
                debug(
                  "walkthrough-jobs",
                  `phase=D but ${missingComments.length} line-anchored concern(s) are missing inline comment(s) — falling through to auto-continuation:`,
                  missingComments
                    .map((i) => `${i.id}[${i.severity}]@${i.filePath}:${i.startLine}`)
                    .join(", "),
                );
              }
              return { _tag: "breakToContinuation" } as const;
            }

            if (event.type === "error") {
              // Only suppress the error when the user explicitly cancelled.
              // A user cancel sets `cancelledByUser` AND interrupts the fiber,
              // so `handleFailure` owns the terminal lifecycle event — emitting
              // here too would double-broadcast. Every OTHER abort of
              // `job.abortController` (scope-close, shutdown) flips
              // `signal.aborted` WITHOUT
              // `cancelledByUser` and does NOT interrupt the fiber, so
              // `handleFailure` never runs. Keying suppression on
              // `signal.aborted` (the old condition) swallowed those errors and
              // returned `returnDone` — the job completed "successfully", no
              // terminal event reached the client, and the row stayed
              // `generating` forever (the observed hang). Fall through to the
              // error path for those so the UI gets a terminal event.
              if (job.cancelledByUser) {
                debug(
                  "walkthrough-jobs",
                  "suppressing error broadcast — cancelled by user:",
                  event.data.message,
                );
                return {
                  _tag: "returnDone",
                  tokenUsage: state.accumulatedTokenUsage,
                } as const;
              }
              yield* setStatus(job.walkthroughId, "error", { errorMessage: event.data.message });
              // The driver's code, so the client can tell an agent sign-in
              // failure (`AGENT_AUTH_REQUIRED`) from any other.
              yield* emitEvent(job.walkthroughId, {
                type: "lifecycle:error",
                data: { code: event.data.code, message: event.data.message },
              }).pipe(Effect.catch(() => Effect.void));
              return {
                _tag: "returnError",
                code: "AiGenerationError",
                message: event.data.message,
              } as const;
            }

            if (event.type === "usage") {
              // Commit the latest occupancy, but only PREVIEW throughput: the
              // generator's running totals aren't final until its `done` event,
              // so we add them transiently for the live broadcast without
              // mutating the accumulator (that single commit happens in `done`).
              state.accumulatedTokenUsage = mergeContextOccupancy(
                state.accumulatedTokenUsage,
                event.data.tokenUsage,
              );
              const combined = addThroughput(state.accumulatedTokenUsage, event.data.tokenUsage);
              yield* emitEvent(job.walkthroughId, {
                type: "usage",
                data: { tokenUsage: combined },
              }).pipe(Effect.catch(() => Effect.void));
              return { _tag: "continue" } as const;
            }

            yield* emitEvent(job.walkthroughId, event).pipe(Effect.catch(() => Effect.void));
            return { _tag: "continue" } as const;
          });

        const buildContinuationEffect = (): Effect.Effect<
          | { readonly _tag: "none" }
          | {
              readonly _tag: "next";
              readonly generator: AsyncGenerator<WalkthroughStreamEvent>;
              readonly partial: PartialSnapshot;
            },
          AiError
        > =>
          Effect.gen(function* () {
            const partialForContinuation = yield* provideDb(
              walkthroughService.getPartial(ctx.pr.id, ctx.prHeadSha, ctx.mode, ctx.generationMode),
            ).pipe(Effect.catch(() => Effect.succeed(null)));

            if (!partialForContinuation) {
              debug("walkthrough-jobs", "auto-continuation: no partial — accepting incomplete");
              return { _tag: "none" } as const;
            }

            const nextGenerator = yield* ai.streamWalkthrough(streamParams(true));
            return {
              _tag: "next",
              generator: nextGenerator,
              partial: partialForContinuation,
            } as const;
          });

        const missingInlineCommentCount = () =>
          findIssuesMissingInlineComment(db, job.walkthroughId).length;
        const adjudicationState = (state: LoopState, partial: PartialSnapshot | null) =>
          buildContinuationAdjudicationState({
            state,
            partial,
            maxAutoContinuations: MAX_AUTO_CONTINUATIONS,
            missingInlineCommentCount: missingInlineCommentCount(),
          });

        const consumeGenerator = (
          state: LoopState,
        ): Effect.Effect<ProcessResult, AiError | DbError> =>
          Effect.gen(function* () {
            const next = yield* Effect.tryPromise({
              try: () => state.currentGenerator.next(),
              catch: (err) => new AiGenerationError({ cause: err }),
            });
            if (next.done) {
              return { _tag: "breakToContinuation" } as const;
            }
            const result = yield* processEvent(state, next.value);
            if (result._tag === "continue") {
              return yield* consumeGenerator(state);
            }
            yield* closeGeneratorBestEffort(state.currentGenerator);
            return result;
          });

        const finishAtBudgetEnd = (
          state: LoopState,
          opts: { readonly stoppedEarlyBecause: string | null },
        ): Effect.Effect<void, AiError | DbError> =>
          finishWalkthroughAtBudgetEnd({
            state,
            stoppedEarlyBecause: opts.stoppedEarlyBecause,
            adjudicationEnabled: ctx.adjudicateContinuations,
            maxAutoContinuations: MAX_AUTO_CONTINUATIONS,
            walkthroughId: job.walkthroughId,
            awaitPendingJudgments: Effect.promise(() => awaitJudgments(job.walkthroughId)),
            loadFinalState: provideDb(
              walkthroughService.getPartial(ctx.pr.id, ctx.prHeadSha, ctx.mode, ctx.generationMode),
            ).pipe(Effect.catch(() => Effect.succeed(null))),
            countMissingInlineComments: missingInlineCommentCount,
            setStatus: (status, options) => setStatus(job.walkthroughId, status, options),
            emitEvent: (event) => emitEvent(job.walkthroughId, event),
          }).pipe(Effect.provideService(JevService, jevService));

        const runWithAutoContinuation = (
          state: LoopState,
        ): Effect.Effect<void, AiError | DbError> =>
          Effect.gen(function* () {
            const result = yield* consumeGenerator(state);
            if (result._tag === "returnDone") {
              return;
            }
            if (result._tag === "returnError") {
              state.terminalReason = `error:${result.code}`;
              return;
            }

            // breakToContinuation — check budget
            if (
              state.autoContinuations >= MAX_AUTO_CONTINUATIONS ||
              job.abortController.signal.aborted
            ) {
              debug(
                "walkthrough-jobs",
                "skipping auto-continuation:",
                state.autoContinuations >= MAX_AUTO_CONTINUATIONS
                  ? "max continuations reached"
                  : "aborted",
              );
              yield* finishAtBudgetEnd(state, { stoppedEarlyBecause: null });
              return;
            }

            // Skip on the first pass: "progress since last continuation" is undefined, and
            // the first continuation is the one that most often succeeds anyway.
            if (state.autoContinuations >= 1) {
              const partialNow = yield* provideDb(
                walkthroughService.getPartial(
                  ctx.pr.id,
                  ctx.prHeadSha,
                  ctx.mode,
                  ctx.generationMode,
                ),
              ).pipe(Effect.catch(() => Effect.succeed(null)));
              const verdict = yield* adjudicateContinuation({
                enabled: ctx.adjudicateContinuations,
                ...adjudicationState(state, partialNow),
              }).pipe(Effect.provideService(JevService, jevService));
              if (verdict.kind === "stop-doomed") {
                debug("walkthrough-jobs", `stopping early: ${verdict.reason}`);
                yield* finishAtBudgetEnd(state, { stoppedEarlyBecause: verdict.reason });
                return;
              }
            }

            const continuation = yield* buildContinuationEffect();
            if (continuation._tag === "none") {
              const currentTokenUsage = state.accumulatedTokenUsage;
              yield* emitEvent(job.walkthroughId, {
                type: "done",
                data: {
                  walkthroughId: job.walkthroughId,
                  tokenUsage: currentTokenUsage,
                },
              }).pipe(Effect.catch(() => Effect.void));
              return;
            }

            state.autoContinuations++;
            // Snapshot for the next adjudication to compare against.
            state.phaseAtLastContinuation = continuation.partial.lastCompletedPhase;
            state.countsAtLastContinuation = continuationCounts(
              continuation.partial,
              missingInlineCommentCount(),
            );
            debug(
              "walkthrough-jobs",
              `auto-continuation ${state.autoContinuations}/${MAX_AUTO_CONTINUATIONS}: lastCompletedPhase=${continuation.partial.lastCompletedPhase}`,
            );

            yield* emitEvent(job.walkthroughId, {
              type: "phase",
              data: {
                phase: "rating",
                message: `Finishing walkthrough (phase ${continuation.partial.lastCompletedPhase})...`,
              },
            }).pipe(Effect.catch(() => Effect.void));

            state.currentGenerator = continuation.generator;
            return yield* runWithAutoContinuation(state);
          });

        const initialState: LoopState = {
          accumulatedTokenUsage: ZERO_TOKEN_USAGE,
          autoContinuations: 0,
          currentGenerator: generator,
          startedAt: Date.now(),
          phaseAtLastContinuation: null,
          countsAtLastContinuation: null,
          terminalReason: "generator-ended",
        };

        yield* runWithAutoContinuation(initialState);

        // KPI telemetry: stamp the generation span (see `launchJob`) with the
        // final token totals. Reached only on a completed run; a
        // failed generation re-raises above and skips this.
        yield* Effect.annotateCurrentSpan(
          "input_tokens",
          initialState.accumulatedTokenUsage.inputTokens,
        );
        yield* Effect.annotateCurrentSpan(
          "output_tokens",
          initialState.accumulatedTokenUsage.outputTokens,
        );
      });

    const launchJob = (job: ActiveJob, ctx: ResolvedContext, trigger: StartJobTrigger) =>
      Effect.withSpan(SPAN.walkthroughJob)(
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan("walkthroughId", job.walkthroughId);
          yield* Effect.annotateCurrentSpan("prId", job.prId);
          yield* Effect.annotateCurrentSpan("headSha", job.prHeadSha);
          yield* Effect.annotateCurrentSpan("trigger", trigger);
          yield* Ref.update(registry, (map) => {
            const next = new Map(map);
            next.set(job.walkthroughId, job);
            return next;
          });

          // Broadcast `lifecycle:started` so the client can pre-create the
          // sidebar spinner entry before any content event arrives. Goes
          // through emitEvent → bumpSeq → Realtime. Best-
          // effort: this is the first emit, so the seq will be 0 in the
          // common case (chat-edits on completed walkthroughs run a separate
          // seq lineage on the same row).
          yield* emitEvent(job.walkthroughId, {
            type: "lifecycle:started",
            data: {
              walkthroughId: job.walkthroughId,
              prHeadSha: job.prHeadSha,
              mode: job.mode,
              trigger,
              // Already on the row; send it now rather than making the UI wait for Phase A's `summary` event.
              ...(ctx.assignedRisk !== null ? { riskLevel: ctx.assignedRisk } : {}),
              modelUsed: ctx.modelUsed,
            },
          }).pipe(Effect.catch(() => Effect.void));

          const handleFailure = (cause: Cause.Cause<AiError | DbError>) =>
            Effect.gen(function* () {
              const interruptedOnly = Cause.hasInterruptsOnly(cause);
              const cancelledByUser = job.cancelledByUser;

              if (!interruptedOnly) {
                logError("walkthrough-jobs", "job failed:", Cause.pretty(cause));
                const failure = Cause.findErrorOption(cause);
                if (Option.isSome(failure)) {
                  const err = failure.value as {
                    _tag: string;
                    message?: string;
                    cause?: unknown;
                  };
                  const tag = err._tag ?? "unknown";
                  const msg = err.message ?? null;
                  const detail =
                    err.cause instanceof Error
                      ? err.cause.message
                      : err.cause != null
                        ? String(err.cause)
                        : null;
                  logError(
                    "walkthrough-jobs",
                    "error detail:",
                    [tag, msg, detail].filter(Boolean).join(" — "),
                  );
                }
                const defect = cause.reasons
                  .filter(Cause.isDieReason)
                  .map((reason) => reason.defect);
                if (defect.length > 0) {
                  for (const d of defect) {
                    logError(
                      "walkthrough-jobs",
                      "defect:",
                      d instanceof Error
                        ? `${d.constructor.name}: ${d.message}\n${d.stack ?? ""}`
                        : JSON.stringify(d, null, 2),
                    );
                  }
                }
              }

              if (analyzeJobFailure(cause, { cancelledByUser }) === "leave-for-resume") {
                debug(
                  "walkthrough-jobs",
                  "job interrupted (likely shutdown) — leaving row for resume:",
                  job.walkthroughId,
                );
                return;
              }

              const failureOpt = Cause.findErrorOption(cause);
              const message = cancelledByUser
                ? WALKTHROUGH_CANCELLED_MESSAGE
                : failureOpt._tag === "Some"
                  ? (failureOpt.value as { cause?: unknown }).cause instanceof Error
                    ? (
                        failureOpt.value as {
                          cause: Error;
                        }
                      ).cause.message
                    : String(
                        (
                          failureOpt.value as {
                            cause?: unknown;
                          }
                        ).cause ?? failureOpt.value,
                      )
                  : "Walkthrough generation failed";
              const code = cancelledByUser ? "Cancelled" : "AiGenerationError";

              // An `error` that didn't commit isn't announced (invariant #8): the
              // row stays `generating` and resume-on-boot picks it up.
              const committed = yield* setStatus(job.walkthroughId, "error", {
                errorMessage: message,
              }).pipe(
                Effect.as(true),
                Effect.catchTag("DbError", (err) =>
                  Effect.sync(() => {
                    logError("walkthrough-jobs", "error status write failed:", err.message);
                    return false;
                  }),
                ),
              );
              if (!committed) return;

              // A superseding cancel has its own announcement coming
              // (`lifecycle:superseded`, emitted by the sweep right after this
              // finalizer returns). Emitting an error first would flash a
              // failure in the UI on every head move and every Regenerate.
              if (job.cancelReason === "superseded") return;

              yield* emitEvent(job.walkthroughId, {
                type: "lifecycle:error",
                data: { code, message },
              }).pipe(Effect.catch(() => Effect.void));
            });

          const scopedBody = buildJobBody(job, ctx).pipe(
            Effect.scoped,
            // Publish the generation span so the ACP driver and the MCP tool
            // handlers — both of which run outside this fiber — can file their
            // spans inside this generation's trace. Listed before the
            // `withSpan` below so it resolves to that span, not the caller's.
            withTraceAnchor(job.walkthroughId),
            withWalkthroughMetrics(job.walkthroughId),
            Effect.annotateLogs({
              walkthroughId: job.walkthroughId,
              prId: job.prId,
            }),
            semaphore.withPermits(1),
            // `onExit`, NOT `catchAllCause`: an interrupted fiber unwinds
            // straight to its finalizers and never enters an error-channel
            // handler, so a `catchAllCause` here silently skipped the whole
            // terminal transition on every user Stop — the row stayed
            // 'generating' forever, `lifecycle:error`/'Cancelled' never
            // broadcast, and resume-on-boot kept re-launching the abandoned
            // job until it burned `WALKTHROUGH_MAX_RESUME_ATTEMPTS`.
            // Finalizers run uninterruptibly, so the DB write lands.
            // Registered inside `removeJob` so the job is still in the
            // registry when `handleFailure` broadcasts.
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? handleFailure(exit.cause) : Effect.void,
            ),
            // The cause is handled above; swallow it so a genuine failure
            // doesn't surface as an unhandled daemon-fiber defect. Skipped on
            // interrupt, which is what leaves the fiber's exit interrupted —
            // exactly the shape it had when this was the only handler.
            Effect.catchCause(() => Effect.void),
            Effect.ensuring(removeJob(job.walkthroughId)),
            Effect.ensuring(
              sessionStore.clearWhere((payload) => payload.walkthroughId === job.walkthroughId),
            ),
            // The generation span. Unlike `WalkthroughJobs.job` (which forks and
            // returns in ~0 ms), this wraps the forked work, so its duration is
            // the real end-to-end generation time — the basis for the
            // walkthrough-gen-duration KPI. KPI attributes (`input_tokens`,
            // `output_tokens`, `tool_call_count`) are annotated from inside
            // `buildJobBody` on completion.
            Effect.withSpan(SPAN.walkthroughGenerate, {
              attributes: {
                walkthroughId: job.walkthroughId,
                prId: job.prId,
                trigger,
                model: ctx.modelUsed,
              },
            }),
          );

          const fiber = yield* scopedBody.pipe(
            withGitHubOrigin("walkthrough:job"),
            Effect.forkDetach,
          );
          job.fiber = fiber as Fiber.Fiber<unknown, unknown>;
        }),
      );

    // ── Public API ──────────────────────────────────────────────────────

    const findActiveByPr = (
      prId: string,
      mode: WalkthroughMode = "reviewer",
    ): Effect.Effect<{ readonly walkthroughId: string; readonly prHeadSha: string } | null> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(registry);
        for (const job of map.values()) {
          if (job.prId === prId && job.mode === mode) {
            return {
              walkthroughId: job.walkthroughId,
              prHeadSha: job.prHeadSha,
            };
          }
        }
        return null;
      });

    const startJob = (params: StartJobParams): Effect.Effect<StartJobResult, StartJobError> =>
      Effect.gen(function* () {
        const mode = params.mode ?? "reviewer";
        // Resume fast-path: if the caller passed a specific walkthroughId
        // (resumePending / explicit resume) and the registry already holds
        // that exact job, short-circuit without acquiring the mutex or
        // touching GitHub. This is the common case for SSE re-subscribe
        // and avoids blocking on any other in-flight startJob for the
        // same PR.
        if (params.walkthroughId !== undefined) {
          const cached = yield* findActiveByPr(params.prId, mode);
          if (cached !== null && cached.walkthroughId === params.walkthroughId) {
            return { walkthroughId: cached.walkthroughId, reused: true };
          }
        }

        // Per-PR serialization (see `startJobMutex` rationale). The
        // remainder of startJob — findActiveByPr, resolveWithDiff,
        // SHA-aware dedup, createPartial, launchJob — runs under the
        // mutex so the check-and-launch is atomic per PR and concurrent
        // callers can't both reach `launchJob` and fork duplicate fibers.
        const mutex = yield* startJobMutex.acquire(params.prId);
        return yield* mutex.withPermits(1)(startJobBody(params));
      });

    const startJobBody = (params: StartJobParams): Effect.Effect<StartJobResult, StartJobError> =>
      Effect.gen(function* () {
        const mode = params.mode ?? "reviewer";
        // Re-check the registry now that we hold the mutex — a concurrent
        // caller may have launched the job for this PR while we waited.
        const existing = yield* findActiveByPr(params.prId, mode);
        if (
          params.walkthroughId !== undefined &&
          existing !== null &&
          existing.walkthroughId === params.walkthroughId
        ) {
          return { walkthroughId: existing.walkthroughId, reused: true };
        }

        const resolved = yield* provideInfra(
          prContextService.resolveWithDiff(params.prId, params.userId),
        );
        const { pr, repo, token, meta, files, commits } = resolved;
        const pinnedHead = params.expectedHeadSha?.toLowerCase();
        if (pinnedHead !== undefined && meta.headSha.toLowerCase() !== pinnedHead) {
          return yield* Effect.fail(
            new HeadShaMismatchError({ expectedHeadSha: pinnedHead, githubHeadSha: meta.headSha }),
          );
        }

        // SHA-aware dedup against the in-flight job (if any). The original
        // fast-path here returned the existing walkthroughId regardless of
        // SHA, which silently handed callers the wrong id when the PR had
        // advanced past `existing.prHeadSha`. Now we explicitly distinguish:
        //   - same SHA → reuse (the stream-handler optimization)
        //   - different SHA → cancel the stale fiber so its permit /
        //     worktree / abort controller release before we spawn the new
        //     one. This mirrors PollScheduler.supersedeForPr's behavior on
        //     a poll-detected commit, so the "user opens the PR before the
        //     poll tick fired" race no longer leaks fibers.
        if (existing !== null) {
          if (existing.prHeadSha === meta.headSha) {
            if (
              params.walkthroughId === undefined ||
              params.walkthroughId === existing.walkthroughId
            ) {
              return { walkthroughId: existing.walkthroughId, reused: true };
            }
          } else {
            yield* cancel(existing.walkthroughId, "superseded");
          }
        }

        const cloneStatus = yield* repoCloneService.getCloneStatus(repo.id);
        if (cloneStatus.status !== "ready") {
          if (cloneStatus.status === "cloning") {
            return yield* Effect.fail(new CloneInProgressError({ repoId: repo.id }));
          }
          const message =
            cloneStatus.status === "error"
              ? `Repository clone failed: ${cloneStatus.error ?? "unknown error"} — check Settings`
              : "Repository has not been cloned yet — check Settings";
          return yield* Effect.fail(
            new AiGenerationError({
              cause: new CloneNotReadyError({ repoId: repo.id }),
              message,
            }),
          );
        }

        // See `expectedHeadSha`. After the clone check, so a run that can't
        // start leaves the previous review standing.
        if (pinnedHead !== undefined) {
          yield* supersedeForPr(pr.id, meta.headSha, mode);
        }

        // One perspective at a time. Both perspectives write their AI threads
        // into the same identity session, so a fresh user start retires the
        // other perspective's rows (and their unsubmitted threads) the same
        // way Regenerate retires this one's. Otherwise Submit would post both
        // walkthroughs' comments.
        if (isUserInitiated(params.trigger)) {
          yield* supersedeForPr(pr.id, undefined, otherWalkthroughMode(mode));
        }

        const requestedGenerationMode = params.generationMode ?? "full";
        let partial = yield* provideDb(
          walkthroughService.getPartial(pr.id, meta.headSha, mode, requestedGenerationMode),
        );
        if (
          params.walkthroughId !== undefined &&
          partial !== null &&
          partial.id !== params.walkthroughId
        ) {
          partial = null;
        }
        if (isUserInitiated(params.trigger) && partial?.status === "error") {
          partial = null;
        }

        const reviewSession = yield* provideDb(reviewService.getOrCreateIdentitySession(pr.id));
        const reviewSessionId = partial?.reviewSessionId ?? reviewSession.id;
        const settings = yield* provideDb(settingsService.getSettings());
        const agent = yield* provideDb(settingsService.resolveAgent());

        const priorArtifact =
          partial === null && requestedGenerationMode === "incremental"
            ? yield* provideDb(walkthroughService.findLatestReviewArtifact(pr.id, mode))
            : null;
        const parentWalkthroughId = partial?.parentWalkthroughId ?? priorArtifact?.id ?? null;
        const baseHeadSha = partial?.baseHeadSha ?? priorArtifact?.prHeadSha ?? null;
        // An incremental run whose base SHA is its own head has an empty commit
        // range — there is nothing to review, so fall back to the full PR diff.
        // Only the fresh-row path is guarded: on a resume (`partial !== null`)
        // the row's generationMode is already committed, and flipping it here
        // would change `createPartial`'s dedup key and collide on the row's id.
        const emptyIncrementalRange = partial === null && baseHeadSha === meta.headSha;
        const resolvedGenerationMode: WalkthroughGenerationMode =
          requestedGenerationMode === "incremental" &&
          parentWalkthroughId &&
          baseHeadSha &&
          !emptyIncrementalRange
            ? "incremental"
            : "full";

        const { stack, diffFingerprint, parentFingerprint, restack } = yield* resolveStackInputs({
          prId: pr.id,
          headSha: meta.headSha,
          mode,
          files,
          partialId: partial?.id ?? null,
          isResume: params.trigger === "resume",
          requestedGenerationMode,
          resolvedGenerationMode,
          parentWalkthroughId,
          snapshotStack: stackService
            .snapshot(resolved)
            .pipe(
              Effect.provideService(DbService, { db }),
              Effect.provideService(CacheService, cacheService),
            ),
        }).pipe(Effect.provideService(WalkthroughService, walkthroughService), provideDb);
        const generationMode = restack?.generationMode ?? resolvedGenerationMode;

        const startPlan = yield* resolveJobStart({
          prId: pr.id,
          headSha: meta.headSha,
          state: { pr, files, commits },
          settings,
          agent,
          trigger: params.trigger,
          cacheProbe:
            restack !== null
              ? Effect.succeed(true)
              : mode === "reviewer" &&
                  settings.cache.enabled &&
                  settings.cache.downloadsEnabled &&
                  partial === null
                ? remoteCache.probe(repo.fullName, meta.headSha)
                : Effect.succeed(false),
        }).pipe(
          Effect.provideService(JevService, jevService),
          Effect.provideService(CacheService, cacheService),
          Effect.provideService(DbService, { db }),
        );
        const { answers, assignedRisk, filePriorities, launchOverride } = startPlan;

        const { modelUsed, providerConfig: providerConfigForJob } = resolveWalkthroughLaunch({
          agent,
          trigger: params.trigger,
          configuredModel: settings.aiModel,
          routedModel: launchOverride?.model,
          priorModel: partial?.modelUsed,
          configuredEffort: settings.aiThinkingEffort,
          routedEffort: launchOverride?.thinkingEffort,
          maxTurns: settings.aiMaxTurns,
        });

        const accountResolution = resolveWalkthroughOwner(db, repo.id);
        const { generatedBy, accountId: ownerAccountId } = accountResolution;

        // Idempotent row creation (upsert on the new unique index).
        // This is the sole "make a walkthrough row exist" call in the
        // codebase — MCP tool handlers never insert, they only update.
        // We also persist the PR commit list here so the agent's
        // `get_commit_history` MCP tool can read it back when authoring
        // the journey chapter (chapter 0). On the "keep existing row"
        // path inside createPartial, the commits are not overwritten —
        // the row already has them from the original insert.
        const idCandidate = partial?.id ?? params.walkthroughId;
        const walkthroughId = yield* provideDb(
          walkthroughService.createPartial({
            ...(idCandidate ? { id: idCandidate } : {}),
            reviewSessionId,
            prId: pr.id,
            modelUsed,
            prHeadSha: meta.headSha,
            mode,
            generationMode,
            parentWalkthroughId,
            baseHeadSha,
            forceNew: isUserInitiated(params.trigger) && generationMode === "full",
            prCommits: commits,
            stackContext: stack,
            diffFingerprint,
            ...(generatedBy ? { generatedBy } : {}),
            // At insert, not a follow-up UPDATE: no kill-9 window without the tier.
            ...(assignedRisk !== null && answers !== null
              ? { risk: { level: assignedRisk, confidence: answers.riskConfidence } }
              : {}),
            providerConfig: providerConfigForJob,
          }),
        );

        if (restack !== null) {
          const carried = yield* tryCarryRestackedWalkthrough({
            db,
            fromWalkthroughId: restack.fromWalkthroughId,
            walkthroughId,
            prId: pr.id,
            repoFullName: repo.fullName,
            headSha: meta.headSha,
            importSnapshot: (snapshot) =>
              provideDb(snapshotImporter.import({ walkthroughId, snapshot })),
            markCarriedFrom: provideDb(
              walkthroughService.markCarriedFrom(walkthroughId, restack.fromWalkthroughId),
            ),
            markComplete: setStatus(walkthroughId, "complete", { tokenUsage: ZERO_TOKEN_USAGE }),
            emitEvent: (event) => emitEvent(walkthroughId, event),
          });
          if (carried) return { walkthroughId, reused: false };
        }

        const importedFromCache = yield* tryImportCachedWalkthrough({
          enabled:
            mode === "reviewer" &&
            settings.cache.enabled &&
            settings.cache.downloadsEnabled &&
            partial === null,
          walkthroughId,
          prId: pr.id,
          repoFullName: repo.fullName,
          headSha: meta.headSha,
          fetchSnapshot: remoteCache.fetch(repo.fullName, meta.headSha),
          importSnapshot: (snapshot) =>
            provideDb(snapshotImporter.import({ walkthroughId, snapshot })),
          markComplete: setStatus(walkthroughId, "complete", { tokenUsage: ZERO_TOKEN_USAGE }),
          emitEvent: (event) => emitEvent(walkthroughId, event),
        });
        if (importedFromCache) return { walkthroughId, reused: false };

        // On user-triggered resume, sync the stored modelUsed to current settings
        // so the DB reflects which agent is actually running this continuation.
        if (params.trigger === "resume" && partial !== null && partial.modelUsed !== modelUsed) {
          yield* provideDb(walkthroughService.updateModelUsed(partial.id, modelUsed));
        }

        const abortController = new AbortController();
        const job: ActiveJob = {
          walkthroughId,
          prId: pr.id,
          prHeadSha: meta.headSha,
          userId: params.userId,
          accountId: ownerAccountId,
          mode,
          abortController,
          activity: makeActivityBeacon(),
          fiber: null,
          cancelledByUser: false,
          cancelReason: null,
        };

        yield* launchJob(
          job,
          {
            pr: {
              id: pr.id,
              title: pr.title,
              body: pr.body,
              sourceBranch: pr.sourceBranch,
              targetBranch: pr.targetBranch,
              url: pr.url,
              externalId: pr.externalId,
            },
            repoId: repo.id,
            repoFullName: repo.fullName,
            githubHost: repo.githubHost,
            token,
            prHeadSha: meta.headSha,
            files,
            partial,
            reviewSessionId,
            modelUsed,
            mode,
            generationMode,
            parentWalkthroughId,
            baseHeadSha,
            launchOverride,
            assignedRisk,
            filePriorities,
            splitRecommendation: startPlan.splitRecommendation,
            adjudicateContinuations: settings.jev.enabled,
            stack,
            parentFingerprint,
          },
          params.trigger,
        );

        return { walkthroughId, reused: false };
      });

    const cancel = (
      walkthroughId: string,
      reason: "user" | "superseded" = "user",
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(registry);
        const job = map.get(walkthroughId);
        if (!job) return;

        debug("walkthrough-jobs", "cancel:", walkthroughId, reason);
        job.cancelledByUser = true;
        job.cancelReason = reason;
        if (!job.abortController.signal.aborted) {
          try {
            job.abortController.abort(new Error("Walkthrough cancelled"));
          } catch {
            /* already aborted */
          }
        }
        const fiber = job.fiber;
        if (fiber) {
          yield* Fiber.interrupt(fiber);
        }
      });

    const reviveFromError = (walkthroughId: string): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        // setStatus is the chokepoint (invariant #11). Going through it
        // keeps any future side-effects (broadcasts, audit hooks) in
        // one place rather than fanning out across callers.
        yield* setStatus(walkthroughId, "generating");
        yield* provideDb(walkthroughService.resetResumeAttempts(walkthroughId));
      });

    const resumePending = (): Effect.Effect<void, DbError> =>
      Effect.withSpan("WalkthroughJobs.resumePending")(
        Effect.gen(function* () {
          const rows = yield* provideDb(walkthroughService.listGenerating());
          debug("walkthrough-jobs", "resumePending: found", rows.length, "generating rows");

          // No worktree GC on resume: the unified per-PR worktree at
          // `worktrees/pr-{prNumber}` is shared across walkthroughs and
          // chat sessions, so it's never orphaned by a walkthrough fiber
          // dying. The next `acquirePrWorktree` call simply refreshes
          // the existing dir to the desired SHA in place.

          for (const row of rows) {
            // An attempt that can't be counted isn't run: resuming it would
            // escape the resume budget (invariant #9).
            const attempts = yield* provideDb(
              walkthroughService.incrementResumeAttempts(row.id),
            ).pipe(
              Effect.catchTag("DbError", (err) =>
                Effect.sync(() => {
                  logError("walkthrough-jobs", `resume of ${row.id} skipped:`, err.message);
                  return null;
                }),
              ),
            );
            if (attempts === null) continue;
            if (attempts > WALKTHROUGH_MAX_RESUME_ATTEMPTS) {
              debug(
                "walkthrough-jobs",
                "walkthrough",
                row.id,
                "exceeded resume attempts — marking error",
              );
              const message = "Walkthrough failed after repeated retries. Try regenerating.";
              const committed = yield* setStatus(row.id, "error", { errorMessage: message }).pipe(
                Effect.as(true),
                Effect.catchTag("DbError", (err) =>
                  Effect.sync(() => {
                    logError(
                      "walkthrough-jobs",
                      `error status write failed for ${row.id}:`,
                      err.message,
                    );
                    return false;
                  }),
                ),
              );
              if (!committed) continue;
              yield* emitEvent(row.id, {
                type: "lifecycle:error",
                data: {
                  code: "ResumeAttemptsExceeded",
                  message,
                },
              }).pipe(Effect.catch(() => Effect.void));
              continue;
            }

            yield* startJob({
              prId: row.pullRequestId,
              userId: "single-user",
              trigger: "resume",
              walkthroughId: row.id,
              mode: row.mode,
              // Carry the row's generationMode so `createPartial` dedups on the
              // correct (prId, headSha, mode, generationMode) tuple and REUSES
              // the existing row. Omitting it defaulted to "full", so resuming
              // an incremental row missed the dedup and tried to INSERT a
              // duplicate id → `UNIQUE constraint failed: walkthroughs.id`,
              // leaving the row stuck at `generating` forever.
              generationMode: row.generationMode,
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  logError(
                    "walkthrough-jobs",
                    "resume startJob failed for",
                    row.id,
                    ":",
                    Cause.pretty(cause),
                  );
                }),
              ),
            );
          }
        }),
      );

    const supersedeForPr = (prId: string, exceptHeadSha?: string, mode?: WalkthroughMode) =>
      Effect.gen(function* () {
        // Cancel any in-flight job first so the fiber's scope finalizer
        // runs before we touch the DB row. See regenerateWalkthroughHandler
        // for the same rationale.
        //
        // `exceptHeadSha` is the escape hatch for PollScheduler's
        // "headSha changed" path: the SSE handler may have raced ahead
        // and already created a walkthrough at the NEW SHA, in which
        // case that job is the freshest possible — cancelling it
        // would just force the user to click Generate again. Regenerate
        // (no exception) still kills everything, since "user wants a
        // do-over" includes any in-flight job at any SHA.
        const map = yield* Ref.get(registry);
        // Capture the walkthrough ids being superseded for the broadcast
        // below. We snapshot from the registry first so the broadcast list
        // includes in-flight jobs even if they don't have a DB row visible
        // to the post-supersede SELECT.
        const supersededIds: string[] = [];
        for (const job of map.values()) {
          if (job.prId !== prId) continue;
          if (mode !== undefined && job.mode !== mode) continue;
          if (exceptHeadSha !== undefined && job.prHeadSha === exceptHeadSha) {
            continue;
          }
          supersededIds.push(job.walkthroughId);
          yield* cancel(job.walkthroughId, "superseded");
        }
        yield* provideDb(walkthroughService.supersedeAllForPr(prId, exceptHeadSha, mode));
        for (const id of supersededIds) {
          yield* emitEvent(id, {
            type: "lifecycle:superseded",
            data: { walkthroughId: id, supersededBy: null },
          }).pipe(Effect.catch(() => Effect.void));
        }
      });

    /**
     * Resolve the `(prId, accountId)` pair used to address an event on the
     * global SSE bus. Fast path checks the in-memory registry (active
     * generation). Slow path joins `walkthroughs → pull_requests →
     * repositories` to cover the chat-edit-on-completed-walkthrough case
     * (CLAUDE.md invariant #7 carve-out) where no fiber is running.
     *
     * Returns `null` if the walkthrough row is gone — the caller bails
     * silently because there's nothing to broadcast about.
     */
    const resolveEventTargets = (
      walkthroughId: string,
      activeJob: ActiveJob | undefined,
    ): Effect.Effect<{ prId: string; accountId: string } | null> => {
      if (activeJob) {
        return Effect.succeed({ prId: activeJob.prId, accountId: activeJob.accountId });
      }
      return dbTry("resolveEventTargets", () =>
        db
          .select({
            prId: walkthroughs.pullRequestId,
            accountId: repositories.accountId,
          })
          .from(walkthroughs)
          .innerJoin(pullRequests, eq(pullRequests.id, walkthroughs.pullRequestId))
          .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
          .where(eq(walkthroughs.id, walkthroughId))
          .get(),
      ).pipe(
        Effect.map((row) => (row ? { prId: row.prId, accountId: row.accountId } : null)),
        // Best-effort broadcast addressing: a DB read failure here just means
        // we skip this one broadcast — clients reconcile from the DB on
        // reconnect (CLAUDE.md invariant #8), same as a missing row.
        Effect.orElseSucceed(() => null),
      );
    };

    const emitEvent = (
      walkthroughId: string,
      event: WalkthroughStreamEvent,
    ): Effect.Effect<EmitResult> =>
      Effect.withSpan(SPAN.walkthroughEmitEvent, {
        attributes: { walkthroughId, eventType: event.type },
      })(
        Effect.gen(function* () {
          // 1. Bump the per-walkthrough seq counter atomically in DB. This
          //    is the authoritative wire seq stamped onto every envelope —
          //    survives kill -9, resumes, chat edits after completion.
          //    Decoupled from the registry so chat-edits on completed
          //    walkthroughs (no fiber) still get correct cursors.
          const seq = yield* provideDb(walkthroughService.bumpSeq(walkthroughId)).pipe(
            Effect.catchTag("DbError", (err) =>
              Effect.sync(() => {
                logError("walkthrough-jobs", `emitEvent ${event.type} not sequenced:`, err.message);
                return null;
              }),
            ),
          );
          if (seq === null) return { kind: "unsequenced" as const, walkthroughId };

          // 2. Resolve broadcast targets (fast path = in-memory job, slow
          //    path = DB join for chat-edit-on-completed-walkthrough).
          const activeJob = (yield* Ref.get(registry)).get(walkthroughId);
          const targets = yield* resolveEventTargets(walkthroughId, activeJob);
          if (targets !== null) {
            // Account-scoped so a multi-account user only sees their own
            // walkthrough events.
            yield* realtime
              .toAccount(targets.accountId, {
                type: "walkthrough:event",
                data: {
                  prId: targets.prId,
                  walkthroughId,
                  seq,
                  event,
                },
              })
              .pipe(Effect.catch(() => Effect.void));
          } else {
            debug(
              "wt-trace",
              `emitEvent-no-target wt=${walkthroughId} type=${event.type} (walkthrough row missing)`,
            );
          }

          return { kind: "delivered" as const, seq };
        }),
      );

    const issueSessionToken = (walkthroughId: string) => sessionStore.issue({ walkthroughId });

    const resolveSessionToken = (token: string) =>
      Effect.gen(function* () {
        // `sessionStore.resolve` enforces TTL + the injected liveness check
        // (job still in the registry). We re-read the registry here only to
        // enrich the result with the job's `prId` for the MCP route.
        const payload = yield* sessionStore.resolve(token);
        if (!payload) return null;
        const job = (yield* Ref.get(registry)).get(payload.walkthroughId);
        if (!job) return null;
        job.activity.note();
        return {
          walkthroughId: payload.walkthroughId,
          prId: job.prId,
          accountId: job.accountId,
        };
      });

    const tryHydrateFromRemoteCache = (
      prId: string,
      headSha: string,
      repoFullName: string,
      mode: WalkthroughMode = "reviewer",
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (mode !== "reviewer") return false;
        const settings = yield* settingsService.getSettings();
        if (!settings.cache.enabled || !settings.cache.downloadsEnabled) return false;

        const snapshotOpt = yield* remoteCache.fetch(repoFullName, headSha);
        if (Option.isNone(snapshotOpt)) return false;

        const snapshot = snapshotOpt.value;

        const reviewSession = yield* provideDb(reviewService.getOrCreateIdentitySession(prId));
        const walkthroughId = yield* provideDb(
          walkthroughService.createPartial({
            reviewSessionId: reviewSession.id,
            prId,
            modelUsed: snapshot.modelUsed,
            prHeadSha: headSha,
            mode,
            generatedBy: snapshot.generatedBy,
            providerConfig: snapshot.providerConfig,
          }),
        );

        const importResult = yield* provideDb(
          snapshotImporter.import({ walkthroughId, snapshot }),
        ).pipe(Effect.result);

        if (importResult._tag === "Failure") {
          logError(
            "walkthrough-jobs",
            `tryHydrateFromRemoteCache import failed pr=${prId}: ${importResult.failure.reason}`,
          );
          return false;
        }

        yield* setStatus(walkthroughId, "complete", { tokenUsage: ZERO_TOKEN_USAGE });
        // New SSE bus only. Clients re-hydrate via `/current` to fetch the
        // imported content; replay-as-events is a follow-up improvement.
        yield* emitEvent(walkthroughId, {
          type: "lifecycle:cache-hit",
          data: { walkthroughId, source: "remote" },
        }).pipe(Effect.catch(() => Effect.void));
        yield* emitEvent(walkthroughId, {
          type: "lifecycle:complete",
          data: {
            walkthroughId,
            tokenUsage: ZERO_TOKEN_USAGE,
          },
        }).pipe(Effect.catch(() => Effect.void));

        debug(
          "walkthrough-jobs",
          `tryHydrateFromRemoteCache hit wt=${walkthroughId} pr=${prId} sha=${headSha}`,
        );
        return true;
      }).pipe(
        Effect.catch((e) => {
          logError(
            "walkthrough-jobs",
            `tryHydrateFromRemoteCache failed pr=${prId}: ${e instanceof Error ? e.message : String(e)}`,
          );
          return Effect.succeed(false);
        }),
      );

    return {
      startJob,
      findActiveByPr,
      cancel,
      reviveFromError,
      resumePending,
      supersedeForPr,
      emitEvent,
      issueSessionToken,
      resolveSessionToken,
      tryHydrateFromRemoteCache,
    };
  }),
);
