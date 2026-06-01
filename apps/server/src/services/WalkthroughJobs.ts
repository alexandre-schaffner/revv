// ── WalkthroughJobs ────────────────────────────────────────────────────────
// Durable, isolated AI walkthrough generator — ORCHESTRATOR only (doctrine
// invariants #2, #11). Owns:
//
//   • An in-memory registry of running fibers keyed by walkthroughId. Purely
//     ephemeral coordination — the DB is the source of truth (invariant #1).
//   • A shared Semaphore (capacity = MAX_CONCURRENT_JOBS) so a burst of
//     "Regenerate" clicks can't spawn unlimited parallel agent turns.
//   • Per-job AbortController, wired into the AI provider so cancellation
//     propagates into the Claude SDK turn OR the opencode HTTP session.
//   • Per-job scope with a detached `git worktree` pinned at prHeadSha.
//   • Per-job opaque session tokens — the HTTP MCP route authenticates
//     opencode's tool calls against this map before dispatching to shared
//     handlers (see apps/server/src/routes/mcp/walkthrough.ts).
//   • `setStatus` — the SOLE writer of the walkthroughs.status column.
//     Every other module that needs to transition a walkthrough's lifecycle
//     goes through this chokepoint (invariant #11).
//   • `supersedeWalkthrough` — called by PollScheduler when a PR's head SHA
//     changes. Marks the old row `'superseded'` with `supersededBy` pointing
//     at the new row (invariant #7). Never mutates in place.
//
// Content writes are NOT here. The agent's MCP tool handlers in
// walkthrough-tools.ts own all content persistence (blocks, issues, ratings,
// summary, sentiment). This service observes events from the provider stream
// ONLY to fan out to subscribers and to react at lifecycle boundaries —
// `done` (generator end) triggers validation + setStatus; `error` triggers
// setStatus('error'). No `addBlock` / `addIssue` / `addRating` calls exist
// here anymore (doctrine invariant #2).

import type {
  GenerationProviderConfig,
  Walkthrough,
  WalkthroughStatus,
  WalkthroughStreamEvent,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { eq } from "drizzle-orm";
import { Cause, Context, Effect, Fiber, Layer, Option, Ref, type Scope } from "effect";
import { findIssuesMissingInlineComment } from "../ai/providers/walkthrough-tools";
import { CLI_WALKTHROUGH_TIMEOUT_MS } from "../constants";
import { account } from "../db/schema/auth";
import { pullRequests } from "../db/schema/pull-requests";
import { remoteUsers } from "../db/schema/remote-users";
import { repositories } from "../db/schema/repositories";
import { walkthroughs } from "../db/schema/walkthroughs";
import {
  type AiError,
  AiGenerationError,
  type CloneError,
  CloneInProgressError,
  CloneNotReadyError,
  DbError,
  type GitHubError,
  type NotFoundError,
  type ReviewError,
  type ValidationError,
} from "../domain/errors";
import { withDb } from "../effects/with-db";
import { debug, logError } from "../logger";
import { AiService, type ContinuationContext } from "./Ai";
import { Broadcaster } from "./Broadcaster";
import { DbService } from "./Db";
import { GitHubEtagCache } from "./GitHubEtagCache";
import { analyzeJobFailure } from "./job-failure";
import { makeStartJobMutex } from "./job-mutex";
import { makeSubscriberRegistry, type SubscriberHandle } from "./job-subscribers";
import { PrContextService } from "./PrContext";
import { RemoteWalkthroughCache } from "./RemoteWalkthroughCache";
import { RepoCloneService } from "./RepoClone";
import { ReviewService } from "./Review";
import { SettingsService } from "./Settings";
import { makeSessionTokenStore } from "./session-token-store";
import { WalkthroughService } from "./Walkthrough";
import { WalkthroughSnapshotImporter } from "./WalkthroughSnapshotImporter";

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
 * Derived from the CLI timeout budget so a token never expires mid-run:
 *   CLI_WALKTHROUGH_TIMEOUT_MS × (1 + MAX_AUTO_CONTINUATIONS) + 5 min margin.
 * This ensures the token outlives even the longest allowed generation session.
 */
const SESSION_TOKEN_TTL_MS = CLI_WALKTHROUGH_TIMEOUT_MS * (1 + MAX_AUTO_CONTINUATIONS) + 5 * 60_000;

// ── Types ────────────────────────────────────────────────────────────────────

type Subscriber = (event: WalkthroughStreamEvent) => void;

/** Result of an emit attempt — used by callers to observe delivery fate. */
export type EmitResult =
  | { readonly kind: "delivered"; readonly seq: number }
  | { readonly kind: "skipped-no-job"; readonly walkthroughId: string };

interface ActiveJob {
  readonly walkthroughId: string;
  readonly prId: string;
  readonly prHeadSha: string;
  readonly userId: string;
  /**
   * Better-auth `account.id` that owns the repo backing this PR. Resolved
   * once at `startJob` time so `emitEvent` can target `Broadcaster.broadcastToAccount`
   * without hitting the DB on every event. Empty string when the repo
   * lookup fails (rare — falls back to global broadcast).
   */
  readonly accountId: string;
  readonly abortController: AbortController;
  readonly subscribers: Set<SubscriberHandle<WalkthroughStreamEvent>>;
  /**
   * Diagnostic-only monotonic counter assigned to every event flowing through
   * the subscriber fan-out. Lets tracing correlate server log lines with
   * client-side event arrival (see `wt-trace` on the web side). Not on the
   * wire — purely for paired-log debugging of the stream-loss bug. Distinct
   * from the durable wire cursor stamped by `walkthroughService.bumpSeq`.
   */
  nextSeq: number;
  fiber: Fiber.RuntimeFiber<unknown, unknown> | null;
  cancelledByUser: boolean;
  /**
   * Number of block-prerender attempts that fell back (threw or returned null).
   * Observability only — answers "is the SSR cache earning its keep?" (S10).
   */
  prerenderFailures: number;
}

export type StartJobTrigger = "user" | "resume" | "review_requested";

/** Error union surfaced by `startJob`. Inherited from its transitive calls. */
export type StartJobError =
  | AiError
  | CloneError
  | CloneInProgressError
  | CloneNotReadyError
  | GitHubError
  | NotFoundError
  | ReviewError
  | ValidationError;

// ── Service tag ──────────────────────────────────────────────────────────────

export class WalkthroughJobs extends Context.Tag("WalkthroughJobs")<
  WalkthroughJobs,
  {
    /**
     * Start (or attach to) a walkthrough generation job for a PR.
     *
     * Idempotent: the UNIQUE INDEX on (pullRequestId, prHeadSha) means a
     * concurrent duplicate start upserts onto the same row. The fast path
     * here also short-circuits when an in-memory job already exists.
     */
    readonly startJob: (params: {
      readonly prId: string;
      readonly userId: string;
      readonly trigger: StartJobTrigger;
      readonly walkthroughId?: string;
    }) => Effect.Effect<{ readonly walkthroughId: string }, StartJobError>;

    /**
     * Probe the remote team cache for `(prId, headSha)` and, on a hit,
     * import + flip the row to `'complete'` — without starting the agent.
     * Returns `true` when a walkthrough was hydrated, `false` on miss or
     * any failure (failures are logged; never propagated to the caller).
     *
     * Meant for the `/cached` route handler so the first page-load
     * immediately hydrates from the team cache rather than showing the
     * Generate button.
     */
    readonly tryHydrateFromRemoteCache: (
      prId: string,
      headSha: string,
      repoFullName: string,
    ) => Effect.Effect<boolean>;

    readonly subscribe: (
      walkthroughId: string,
      onEvent: Subscriber,
    ) => Effect.Effect<SubscribeResult>;

    readonly findActiveByPr: (
      prId: string,
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
    readonly reviveFromError: (walkthroughId: string) => Effect.Effect<void>;

    readonly resumePending: () => Effect.Effect<void>;

    /**
     * Supersede one walkthrough with another (both for the same PR but
     * different head SHAs). Called by PollScheduler when a new commit
     * arrives. Per doctrine invariant #7, the old row is marked
     * 'superseded' rather than mutated in place.
     */
    readonly supersedeWalkthrough: (oldId: string, newId: string) => Effect.Effect<void>;

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
    readonly supersedeForPr: (prId: string, exceptHeadSha?: string) => Effect.Effect<void>;

    /**
     * Fan an event out to a running job's subscribers. The primary caller
     * is the HTTP MCP route — when opencode makes a tool call against
     * `/mcp/walkthrough`, the handler commits to DB then invokes this to
     * broadcast the resulting event. No-op if no active job.
     *
     * Returns `Effect<EmitResult>` so callers can observe whether the event
     * was delivered or silently dropped (S1). The `EmitResult` discriminant
     * (`kind: "delivered" | "skipped-no-job`) lets the MCP tool handler
     * decide whether to log a skip with full context.
     */
    readonly emitEvent: (
      walkthroughId: string,
      event: WalkthroughStreamEvent,
    ) => Effect.Effect<EmitResult>;

    /**
     * Issue an opaque session token for the HTTP MCP route. Tokens resolve
     * to a walkthroughId and are valid only while the job is running. The
     * token is cleared automatically on scope close.
     */
    readonly issueSessionToken: (walkthroughId: string) => Effect.Effect<string>;

    /**
     * Resolve a session token. Returns null if expired or unknown, or if
     * the job is no longer running. Used by the HTTP MCP route to
     * authenticate incoming tool calls from the opencode daemon.
     */
    readonly resolveSessionToken: (token: string) => Effect.Effect<{
      readonly walkthroughId: string;
      readonly prId: string;
      readonly accountId: string;
    } | null>;

    /** Invalidate a session token early (e.g. on job cancel). */
    readonly clearSessionToken: (token: string) => Effect.Effect<void>;

    /**
     * Increment the per-job prerender-failure counter (S10). Pure
     * observability — no correctness impact.
     */
    readonly incrementPrerenderFailures: (walkthroughId: string) => Effect.Effect<void>;
  }
>() {}

export type SubscribeResult =
  | {
      readonly found: true;
      readonly unsubscribe: () => void;
      readonly flush: () => void;
    }
  | { readonly found: false };

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
    const snapshotImporter = yield* WalkthroughSnapshotImporter;
    const broadcaster = yield* Broadcaster;

    const registry = yield* Ref.make(new Map<string, ActiveJob>());
    const semaphore = yield* Effect.makeSemaphore(MAX_CONCURRENT_JOBS);

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

    // Per-job SSE subscriber fan-out (3-strike error budget, pre-flush
    // buffering). Subscriber state lives on each `ActiveJob`; this owns only
    // the shared algorithm.
    const subscribers = makeSubscriberRegistry<WalkthroughStreamEvent>({
      traceScope: "wt-trace",
      errorScope: "walkthrough-jobs",
      idLabel: "wt",
      handleIdPrefix: "h",
    });

    // Opaque-token → walkthroughId store. Ephemeral coordination (invariant #1):
    // tokens are never persisted; on restart they're regenerated by the resume
    // path. The HTTP MCP route resolves against this store. The injected
    // liveness predicate makes a token stop resolving the moment its job leaves
    // the registry (the job died), even before TTL expiry.
    const sessionStore = yield* makeSessionTokenStore<{ readonly walkthroughId: string }>(
      SESSION_TOKEN_TTL_MS,
      (payload) => Effect.map(Ref.get(registry), (map) => map.has(payload.walkthroughId)),
    );

    // Activity notifiers for the opencode provider path. Keyed by walkthroughId.
    // The opencode provider registers a callback here; emitEvent fires it after
    // each tool call so the stream guard's inactivity timer resets even when the
    // opencode SSE subscription misses events.
    const activityNotifiers = yield* Ref.make(
      new Map<string, (event: WalkthroughStreamEvent) => void>(),
    );

    const registerActivityNotifier = (
      walkthroughId: string,
      callback: (event: WalkthroughStreamEvent) => void,
    ) =>
      Ref.update(activityNotifiers, (map) => {
        const next = new Map(map);
        next.set(walkthroughId, callback);
        return next;
      });

    const unregisterActivityNotifier = (walkthroughId: string) =>
      Ref.update(activityNotifiers, (map) => {
        if (!map.has(walkthroughId)) return map;
        const next = new Map(map);
        next.delete(walkthroughId);
        return next;
      });

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
      options?: { tokenUsage?: WalkthroughTokenUsage },
    ) =>
      Effect.withSpan("WalkthroughJobs.setStatus", {
        attributes: { walkthroughId, status },
      })(
        provideDb(
          walkthroughService.setStatus(walkthroughId, status, {
            ...(options?.tokenUsage ? { tokenUsage: options.tokenUsage } : {}),
          }),
        ),
      );

    // Subscriber fan-out lives in `subscribers` (job-subscribers.ts).
    // Commit-first / broadcast-second (invariant #8): by the time an event
    // reaches `subscribers.fanOut`, the MCP tool handler (content events) or
    // the orchestrator (lifecycle events) has already committed the DB write.
    // Broadcast failures never roll back state — a reconnecting subscriber
    // recovers the truth from DB.

    const removeJob = (walkthroughId: string) =>
      Effect.all(
        [
          Ref.update(registry, (map) => {
            if (!map.has(walkthroughId)) return map;
            const next = new Map(map);
            next.delete(walkthroughId);
            return next;
          }),
          unregisterActivityNotifier(walkthroughId),
        ],
        { discard: true },
      );

    // ── Core job body ───────────────────────────────────────────────────

    type PartialSnapshot = Walkthrough & {
      readonly status: "generating" | "error";
      readonly opencodeSessionId: string | null;
    };

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
      readonly files: ReadonlyArray<{
        readonly filename: string;
        readonly previousFilename: string | null;
        readonly status: string;
        readonly additions: number;
        readonly deletions: number;
        readonly patch: string | null;
      }>;
      readonly partial: PartialSnapshot | null;
      readonly reviewSessionId: string;
      readonly modelUsed: string;
    };

    interface LoopState {
      accumulatedTokenUsage: WalkthroughTokenUsage;
      autoContinuations: number;
      currentGenerator: AsyncGenerator<WalkthroughStreamEvent>;
      capturedOpencodeSessionId: string | undefined;
    }

    type ProcessResult =
      | { readonly _tag: "continue" }
      | { readonly _tag: "breakToContinuation" }
      | { readonly _tag: "returnDone"; readonly tokenUsage: WalkthroughTokenUsage }
      | { readonly _tag: "returnError"; readonly code: string; readonly message: string };

    const buildJobBody = (
      job: ActiveJob,
      ctx: ResolvedContext,
    ): Effect.Effect<void, AiError, Scope.Scope> =>
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

        const { worktreePath } = yield* repoCloneService
          .acquirePrWorktree({
            repoId: ctx.repoId,
            prNumber: ctx.pr.externalId,
            prHeadSha: ctx.prHeadSha,
            githubToken: ctx.token,
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

        // Generator construction — resume vs fresh. Note: content
        // writes now happen INSIDE the MCP tool handlers, so the
        // continuation context here is purely informational for the
        // AI provider (which may still want to know e.g. the
        // opencode session id for `--continue`).
        const partial = ctx.partial;
        let generator: AsyncGenerator<WalkthroughStreamEvent>;
        let capturedOpencodeSessionId: string | undefined;

        const buildStreamParams = (overrideContinuation?: ContinuationContext) => ({
          pr: {
            title: ctx.pr.title,
            body: ctx.pr.body,
            sourceBranch: ctx.pr.sourceBranch,
            targetBranch: ctx.pr.targetBranch,
            url: ctx.pr.url,
          },
          files: ctx.files as never,
          worktreePath,
          walkthroughId: job.walkthroughId,
          accountId: job.accountId,
          ...(overrideContinuation ? { continuation: overrideContinuation } : {}),
          onSessionId: (id: string) => {
            capturedOpencodeSessionId = id;
          },
          abortController: job.abortController,
          // Route MCP tool handler events through WalkthroughJobs.emitEvent
          // so both Claude and opencode converge at a single emit site (P1).
          // The callback is synchronous (runSync) to match the HTTP MCP route
          // behavior - see apps/server/src/routes/mcp/walkthrough.ts:70-93.
          emitEvent: (event: WalkthroughStreamEvent) => {
            try {
              Effect.runSync(emitEvent(job.walkthroughId, event));
            } catch {
              /* emitEvent logs its own failures */
            }
          },
          // Supply opencode-path session-token callbacks. Ignored by
          // the Claude SDK path. WalkthroughJobs owns the session-token
          // store (`sessionStore`) — passing these through as callbacks
          // avoids a layer-level cycle between AiService and WalkthroughJobs.
          issueOpencodeSessionToken: (walkthroughId: string) =>
            Effect.runPromise(issueSessionToken(walkthroughId)),
          clearOpencodeSessionToken: (token: string) => Effect.runPromise(clearSessionToken(token)),
          registerOpencodeActivityNotifier: (
            walkthroughId: string,
            callback: (event: WalkthroughStreamEvent) => void,
          ) => Effect.runPromise(registerActivityNotifier(walkthroughId, callback)),
          unregisterOpencodeActivityNotifier: (walkthroughId: string) =>
            Effect.runPromise(unregisterActivityNotifier(walkthroughId)),
        });

        if (partial) {
          const continuation: ContinuationContext = {
            walkthroughId: partial.id,
            existingBlocks: partial.blocks,
            existingIssueCount: partial.issues.length,
            existingRatedAxes: partial.ratings.map((r) => r.axis),
            ...(partial.opencodeSessionId ? { opencodeSessionId: partial.opencodeSessionId } : {}),
          };
          generator = yield* ai.streamWalkthrough(buildStreamParams(continuation));
        } else {
          generator = yield* ai.streamWalkthrough(buildStreamParams());
        }

        // ── Event loop ──────────────────────────────────────────────
        //
        // The old persist-then-fanout pattern is GONE. Content events
        // (`summary`, `block`, `issue`, `rating`, `sentiment`) have
        // already been persisted by the MCP tool handler that emitted
        // them. This loop only:
        //   - Fans out to subscribers (best effort, per invariant #8).
        //   - Tracks orchestrator-level state (token usage, phase
        //     progress) for auto-continuation + completion.
        //   - Reacts to the terminal `done` / `error` events.

        const processEvent = (
          state: LoopState,
          event: WalkthroughStreamEvent,
        ): Effect.Effect<ProcessResult, never, never> =>
          Effect.gen(function* () {
            if (event.type === "done") {
              state.accumulatedTokenUsage = {
                inputTokens:
                  state.accumulatedTokenUsage.inputTokens + event.data.tokenUsage.inputTokens,
                outputTokens:
                  state.accumulatedTokenUsage.outputTokens + event.data.tokenUsage.outputTokens,
                cacheReadInputTokens:
                  state.accumulatedTokenUsage.cacheReadInputTokens +
                  event.data.tokenUsage.cacheReadInputTokens,
                cacheCreationInputTokens:
                  state.accumulatedTokenUsage.cacheCreationInputTokens +
                  event.data.tokenUsage.cacheCreationInputTokens,
              };

              yield* emitEvent(job.walkthroughId, {
                type: "usage",
                data: { tokenUsage: state.accumulatedTokenUsage },
              }).pipe(Effect.catchAll(() => Effect.void));

              const dbState = yield* provideDb(
                walkthroughService.getPartial(ctx.pr.id, ctx.prHeadSha),
              ).pipe(Effect.catchAll(() => Effect.succeed(null)));

              if (dbState?.lastCompletedPhase === "D") {
                const missingComments = findIssuesMissingInlineComment(db, job.walkthroughId);
                if (missingComments.length === 0) {
                  yield* setStatus(job.walkthroughId, "complete", {
                    tokenUsage: state.accumulatedTokenUsage,
                  });
                  // Fire-and-forget push to the team cache. Failures log
                  // inside the service and never block job completion
                  // (invariant #8 — commit first, broadcast second; the
                  // cache push is broadcast-equivalent).
                  yield* Effect.forkDaemon(
                    remoteCache.push(job.walkthroughId).pipe(Effect.catchAll(() => Effect.void)),
                  );
                  yield* emitEvent(job.walkthroughId, {
                    type: "lifecycle:complete",
                    data: {
                      walkthroughId: job.walkthroughId,
                      tokenUsage: state.accumulatedTokenUsage,
                    },
                  }).pipe(Effect.catchAll(() => Effect.void));
                  return { _tag: "returnDone", tokenUsage: state.accumulatedTokenUsage } as const;
                }
                debug(
                  "walkthrough-jobs",
                  `phase=D but ${missingComments.length} warning/critical issue(s) missing inline comment(s) — falling through to auto-continuation:`,
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
              // `job.abortController` (the 10-minute hard timeout in the
              // provider, scope-close, shutdown) flips `signal.aborted` WITHOUT
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
                return { _tag: "returnDone", tokenUsage: state.accumulatedTokenUsage } as const;
              }
              yield* setStatus(job.walkthroughId, "error");
              yield* emitEvent(job.walkthroughId, {
                type: "lifecycle:error",
                data: { code: "AiGenerationError", message: event.data.message },
              }).pipe(Effect.catchAll(() => Effect.void));
              return {
                _tag: "returnError",
                code: "AiGenerationError",
                message: event.data.message,
              } as const;
            }

            if (event.type === "usage") {
              const combined = {
                inputTokens:
                  state.accumulatedTokenUsage.inputTokens + event.data.tokenUsage.inputTokens,
                outputTokens:
                  state.accumulatedTokenUsage.outputTokens + event.data.tokenUsage.outputTokens,
                cacheReadInputTokens:
                  state.accumulatedTokenUsage.cacheReadInputTokens +
                  event.data.tokenUsage.cacheReadInputTokens,
                cacheCreationInputTokens:
                  state.accumulatedTokenUsage.cacheCreationInputTokens +
                  event.data.tokenUsage.cacheCreationInputTokens,
              };
              logError(
                "walkthrough-jobs",
                `[usage-diag] fanOut usage combined=${JSON.stringify(combined)} subscribers=${job.subscribers.size}`,
              );
              yield* emitEvent(job.walkthroughId, {
                type: "usage",
                data: { tokenUsage: combined },
              }).pipe(Effect.catchAll(() => Effect.void));
              return { _tag: "continue" } as const;
            }

            // `thinking` events are the activity-notifier heartbeat — they enter
            // the provider's events queue solely to reset the stream guard's
            // inactivity timer when an MCP tool handler fires emitEvent.
            // Re-emitting them through emitEvent would call notify(thinking)
            // again, pushing another thinking event into the queue and producing
            // an unbounded loop (one observed run hit 200k+ seqs/sec). Drop on
            // the consumer side — clients no-op on this type anyway.
            if (event.type === "thinking") {
              return { _tag: "continue" } as const;
            }

            yield* emitEvent(job.walkthroughId, event).pipe(Effect.catchAll(() => Effect.void));
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
              walkthroughService.getPartial(ctx.pr.id, ctx.prHeadSha),
            ).pipe(Effect.catchAll(() => Effect.succeed(null)));

            if (!partialForContinuation) {
              debug("walkthrough-jobs", "auto-continuation: no partial — accepting incomplete");
              return { _tag: "none" } as const;
            }

            const continuationCtx: ContinuationContext = {
              walkthroughId: partialForContinuation.id,
              existingBlocks: partialForContinuation.blocks,
              existingIssueCount: partialForContinuation.issues.length,
              existingRatedAxes: partialForContinuation.ratings.map((r) => r.axis),
              ...(partialForContinuation.opencodeSessionId
                ? { opencodeSessionId: partialForContinuation.opencodeSessionId }
                : {}),
            };

            const nextGenerator = yield* ai.streamWalkthrough(buildStreamParams(continuationCtx));
            return {
              _tag: "next",
              generator: nextGenerator,
              partial: partialForContinuation,
            } as const;
          });

        const consumeGenerator = (state: LoopState): Effect.Effect<ProcessResult, AiError> =>
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
            return result;
          });

        const runWithAutoContinuation = (state: LoopState): Effect.Effect<void, AiError> =>
          Effect.gen(function* () {
            const result = yield* consumeGenerator(state);
            if (result._tag === "returnDone") {
              return;
            }
            if (result._tag === "returnError") {
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
              const finalState = yield* provideDb(
                walkthroughService.getPartial(ctx.pr.id, ctx.prHeadSha),
              ).pipe(Effect.catchAll(() => Effect.succeed(null)));
              const phaseD = finalState?.lastCompletedPhase === "D";
              const missingCommentsAtExhaustion = phaseD
                ? findIssuesMissingInlineComment(db, job.walkthroughId)
                : [];
              if (!phaseD || missingCommentsAtExhaustion.length > 0) {
                if (phaseD && missingCommentsAtExhaustion.length > 0) {
                  debug(
                    "walkthrough-jobs",
                    `exhausted auto-continuations with ${missingCommentsAtExhaustion.length} warning/critical issue(s) still missing inline comment(s) — marking error`,
                  );
                }
                yield* setStatus(job.walkthroughId, "error");
              }
              // Exhausted: legacy SSE clients still expect `done`; new
              // clients get `lifecycle:complete` only if the row actually
              // reached phase D with no missing comments. When the
              // exhaustion forced an error, emit `lifecycle:error` instead
              // so new clients see a terminal failure rather than a fake
              // success.
              if (!phaseD || missingCommentsAtExhaustion.length > 0) {
                yield* emitEvent(job.walkthroughId, {
                  type: "lifecycle:error",
                  data: {
                    code: "AutoContinuationExhausted",
                    message: phaseD
                      ? "Generation finished but warning/critical issues lack inline comments."
                      : "Generation exhausted auto-continuation budget before reaching phase D.",
                  },
                }).pipe(Effect.catchAll(() => Effect.void));
              } else {
                yield* emitEvent(job.walkthroughId, {
                  type: "lifecycle:complete",
                  data: {
                    walkthroughId: job.walkthroughId,
                    tokenUsage: state.accumulatedTokenUsage,
                  },
                }).pipe(Effect.catchAll(() => Effect.void));
              }
              yield* emitEvent(job.walkthroughId, {
                type: "done",
                data: {
                  walkthroughId: job.walkthroughId,
                  tokenUsage: state.accumulatedTokenUsage,
                },
              }).pipe(Effect.catchAll(() => Effect.void));
              return;
            }

            const continuation = yield* buildContinuationEffect();
            if (continuation._tag === "none") {
              yield* emitEvent(job.walkthroughId, {
                type: "done",
                data: {
                  walkthroughId: job.walkthroughId,
                  tokenUsage: state.accumulatedTokenUsage,
                },
              }).pipe(Effect.catchAll(() => Effect.void));
              return;
            }

            state.autoContinuations++;
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
            }).pipe(Effect.catchAll(() => Effect.void));

            state.currentGenerator = continuation.generator;
            return yield* runWithAutoContinuation(state);
          });

        const initialState: LoopState = {
          accumulatedTokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          autoContinuations: 0,
          currentGenerator: generator,
          capturedOpencodeSessionId: undefined,
        };

        yield* Effect.gen(function* () {
          yield* runWithAutoContinuation(initialState);
        }).pipe(
          Effect.ensuring(
            capturedOpencodeSessionId !== undefined
              ? provideDb(
                  walkthroughService.setOpencodeSessionId(
                    job.walkthroughId,
                    capturedOpencodeSessionId,
                  ),
                ).pipe(Effect.catchAll(() => Effect.void))
              : Effect.void,
          ),
        );
      });

    const launchJob = (job: ActiveJob, ctx: ResolvedContext, trigger: StartJobTrigger) =>
      Effect.withSpan("WalkthroughJobs.job")(
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
          // through emitEvent → bumpSeq → Broadcaster + legacy fanOut. Best-
          // effort: this is the first emit, so the seq will be 0 in the
          // common case (chat-edits on completed walkthroughs run a separate
          // seq lineage on the same row).
          yield* emitEvent(job.walkthroughId, {
            type: "lifecycle:started",
            data: {
              walkthroughId: job.walkthroughId,
              prHeadSha: job.prHeadSha,
              trigger,
            },
          }).pipe(Effect.catchAll(() => Effect.void));

          const handleFailure = (cause: Cause.Cause<AiError>) =>
            Effect.gen(function* () {
              const interruptedOnly = Cause.isInterruptedOnly(cause);
              const cancelledByUser = job.cancelledByUser;

              if (!interruptedOnly) {
                logError("walkthrough-jobs", "job failed:", Cause.pretty(cause));
                const failure = Cause.failureOption(cause);
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
                const defect = Cause.defects(cause);
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

              const failureOpt = Cause.failureOption(cause);
              const message = cancelledByUser
                ? "Walkthrough cancelled"
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

              yield* setStatus(job.walkthroughId, "error").pipe(Effect.catchAll(() => Effect.void));

              yield* emitEvent(job.walkthroughId, {
                type: "lifecycle:error",
                data: { code, message },
              }).pipe(Effect.catchAll(() => Effect.void));
            });

          const scopedBody = buildJobBody(job, ctx).pipe(
            Effect.scoped,
            Effect.annotateLogs({
              walkthroughId: job.walkthroughId,
              prId: job.prId,
            }),
            semaphore.withPermits(1),
            Effect.catchAllCause(handleFailure),
            Effect.ensuring(removeJob(job.walkthroughId)),
            Effect.ensuring(
              // Clear any session tokens issued for this job.
              sessionStore.clearWhere((payload) => payload.walkthroughId === job.walkthroughId),
            ),
          );

          const fiber = yield* Effect.forkDaemon(scopedBody);
          job.fiber = fiber as Fiber.RuntimeFiber<unknown, unknown>;
        }),
      );

    // ── Public API ──────────────────────────────────────────────────────

    const findActiveByPr = (
      prId: string,
    ): Effect.Effect<{ readonly walkthroughId: string; readonly prHeadSha: string } | null> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(registry);
        for (const job of map.values()) {
          if (job.prId === prId) {
            return {
              walkthroughId: job.walkthroughId,
              prHeadSha: job.prHeadSha,
            };
          }
        }
        return null;
      });

    const startJob = (params: {
      readonly prId: string;
      readonly userId: string;
      readonly trigger: StartJobTrigger;
      readonly walkthroughId?: string;
    }): Effect.Effect<{ readonly walkthroughId: string }, StartJobError> =>
      Effect.gen(function* () {
        // Resume fast-path: if the caller passed a specific walkthroughId
        // (resumePending / explicit resume) and the registry already holds
        // that exact job, short-circuit without acquiring the mutex or
        // touching GitHub. This is the common case for SSE re-subscribe
        // and avoids blocking on any other in-flight startJob for the
        // same PR.
        if (params.walkthroughId !== undefined) {
          const cached = yield* findActiveByPr(params.prId);
          if (cached !== null && cached.walkthroughId === params.walkthroughId) {
            return { walkthroughId: cached.walkthroughId };
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

    const startJobBody = (params: {
      readonly prId: string;
      readonly userId: string;
      readonly trigger: StartJobTrigger;
      readonly walkthroughId?: string;
    }): Effect.Effect<{ readonly walkthroughId: string }, StartJobError> =>
      Effect.gen(function* () {
        // Re-check the registry now that we hold the mutex — a concurrent
        // caller may have launched the job for this PR while we waited.
        const existing = yield* findActiveByPr(params.prId);
        if (
          params.walkthroughId !== undefined &&
          existing !== null &&
          existing.walkthroughId === params.walkthroughId
        ) {
          return { walkthroughId: existing.walkthroughId };
        }

        const resolved = yield* provideInfra(
          prContextService.resolveWithDiff(params.prId, params.userId),
        );
        const { pr, repo, token, meta, files, commits } = resolved;

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
              return {
                walkthroughId: existing.walkthroughId,
              };
            }
          } else {
            yield* cancel(existing.walkthroughId);
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

        let partial = yield* provideDb(walkthroughService.getPartial(pr.id, meta.headSha));
        if (
          params.walkthroughId !== undefined &&
          partial !== null &&
          partial.id !== params.walkthroughId
        ) {
          partial = null;
        }

        const reviewSession = yield* provideDb(reviewService.getOrCreateActiveSession(pr.id));
        const reviewSessionId = partial?.reviewSessionId ?? reviewSession.id;

        const settings = yield* provideDb(settingsService.getSettings());
        const agent = yield* provideDb(settingsService.resolveAgent());
        const freshModelUsed =
          settings.aiModel ?? (agent === "opencode" ? "opencode" : "claude-sonnet-4-20250514");
        const modelUsed =
          params.trigger === "resume"
            ? freshModelUsed
            : partial?.modelUsed && partial.modelUsed !== "unknown"
              ? partial.modelUsed
              : freshModelUsed;

        // Snapshot the AI provider config at job start. We persist this
        // alongside `modelUsed` so a mid-job settings change cannot
        // corrupt the recorded config — the row reflects what was
        // actually running, and the same JSON gets exported to the
        // remote cache as `providerConfig`.
        const providerConfigForJob: GenerationProviderConfig = {
          provider: agent === "opencode" ? "opencode" : "claude-agent-sdk",
          model: modelUsed,
          thinkingEffort: settings.aiThinkingEffort ?? null,
          contextWindow: settings.aiContextWindow ?? null,
          maxTurns: settings.aiMaxTurns,
        };

        // Resolve `GeneratedBy` + owning account id from the OAuth account
        // that owns the repo. Best-effort — if rows are missing we skip
        // attribution rather than fail the job. The `accountId` flows into
        // `ActiveJob` so `emitEvent` can target `Broadcaster.broadcastToAccount`
        // without re-querying the DB on every event.
        const accountResolution = (() => {
          const repoRow = db
            .select({ accountId: repositories.accountId })
            .from(repositories)
            .where(eq(repositories.id, repo.id))
            .get();
          if (!repoRow) return { accountId: "", generatedBy: undefined };
          const acc = db
            .select({
              accountId: account.accountId,
              githubLogin: account.githubLogin,
              avatarUrl: account.avatarUrl,
            })
            .from(account)
            .where(eq(account.id, repoRow.accountId))
            .get();
          if (!acc?.githubLogin) {
            return { accountId: repoRow.accountId, generatedBy: undefined };
          }
          const githubUserId = Number(acc.accountId);

          // Resolve avatar content from remote_users.
          const avatarContent =
            db
              .select({ avatarContent: remoteUsers.avatarContent })
              .from(remoteUsers)
              .where(eq(remoteUsers.login, acc.githubLogin))
              .get()?.avatarContent ?? null;

          return {
            accountId: repoRow.accountId,
            generatedBy: {
              githubUserId: Number.isFinite(githubUserId) ? githubUserId : 0,
              githubLogin: acc.githubLogin,
              displayName: null,
              avatarContent,
            },
          };
        })();
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
            prCommits: commits,
            ...(generatedBy ? { generatedBy } : {}),
            providerConfig: providerConfigForJob,
          }),
        ).pipe(
          Effect.mapError(
            (err) =>
              new AiGenerationError({
                cause: err,
                message: err instanceof Error ? err.message : String(err),
              }),
          ),
        );

        // ── Remote cache probe ────────────────────────────────────────
        // After the row exists (so subscribers see a consistent target)
        // we ask the team cache whether a snapshot for this `(repo,
        // headSha)` is available. On hit, we import + flip status to
        // 'complete' and skip the agent fiber entirely. On miss / any
        // failure, fall through to the usual generation path. This is
        // safe for `partial !== null` paths too — the importer wipes
        // any leftover partial children inside its transaction.
        if (settings.cache.enabled && settings.cache.downloadsEnabled && partial === null) {
          const snapshotOpt = yield* remoteCache.fetch(repo.fullName, meta.headSha);
          if (Option.isSome(snapshotOpt)) {
            const importResult = yield* provideDb(
              snapshotImporter.import({
                walkthroughId,
                snapshot: snapshotOpt.value,
              }),
            ).pipe(Effect.either);
            if (importResult._tag === "Right") {
              yield* setStatus(walkthroughId, "complete");
              // New clients see the cache-hit marker + lifecycle:complete on
              // the global SSE bus and re-hydrate via REST `/current` to get
              // the imported content. (A future iteration can replay the
              // imported rows as content events through emitEvent — see the
              // plan's §4.10 — so clients render inline without a follow-up
              // fetch.)
              yield* emitEvent(walkthroughId, {
                type: "lifecycle:cache-hit",
                data: { walkthroughId, source: "remote" },
              }).pipe(Effect.catchAll(() => Effect.void));
              yield* emitEvent(walkthroughId, {
                type: "lifecycle:complete",
                data: {
                  walkthroughId,
                  tokenUsage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadInputTokens: 0,
                    cacheCreationInputTokens: 0,
                  },
                },
              }).pipe(Effect.catchAll(() => Effect.void));
              debug(
                "walkthrough-jobs",
                `cache hit wt=${walkthroughId} pr=${pr.id} sha=${meta.headSha} — skipping agent`,
              );
              return { walkthroughId };
            }
            logError(
              "walkthrough-jobs",
              `cache import failed wt=${walkthroughId} — falling through to agent: ${importResult.left.reason}`,
            );
          }
        }

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
          abortController,
          subscribers: new Set(),
          nextSeq: 0,
          fiber: null,
          cancelledByUser: false,
          prerenderFailures: 0,
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
            token,
            prHeadSha: meta.headSha,
            files,
            partial,
            reviewSessionId,
            modelUsed,
          },
          params.trigger,
        );

        return { walkthroughId };
      });

    const subscribe = (
      walkthroughId: string,
      onEvent: Subscriber,
    ): Effect.Effect<SubscribeResult> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(registry);
        const job = map.get(walkthroughId);
        if (!job) {
          debug("wt-trace", `subscribe-miss wt=${walkthroughId} (job not in registry)`);
          return { found: false };
        }

        const { unsubscribe, flush } = subscribers.subscribe(walkthroughId, job, onEvent);
        return { found: true, unsubscribe, flush };
      });

    const cancel = (walkthroughId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(registry);
        const job = map.get(walkthroughId);
        if (!job) return;

        debug("walkthrough-jobs", "cancel:", walkthroughId);
        job.cancelledByUser = true;
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

    const reviveFromError = (walkthroughId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        // setStatus is the chokepoint (invariant #11). Going through it
        // keeps any future side-effects (broadcasts, audit hooks) in
        // one place rather than fanning out across callers.
        yield* setStatus(walkthroughId, "generating");
        yield* provideDb(walkthroughService.resetResumeAttempts(walkthroughId));
      });

    const resumePending = (): Effect.Effect<void> =>
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
            const attempts = yield* provideDb(walkthroughService.incrementResumeAttempts(row.id));
            if (attempts > WALKTHROUGH_MAX_RESUME_ATTEMPTS) {
              debug(
                "walkthrough-jobs",
                "walkthrough",
                row.id,
                "exceeded resume attempts — marking error",
              );
              yield* setStatus(row.id, "error");
              yield* emitEvent(row.id, {
                type: "lifecycle:error",
                data: {
                  code: "ResumeAttemptsExceeded",
                  message: "Walkthrough failed after repeated retries. Try regenerating.",
                },
              }).pipe(Effect.catchAll(() => Effect.void));
              continue;
            }

            yield* startJob({
              prId: row.pullRequestId,
              userId: "single-user",
              trigger: "resume",
              walkthroughId: row.id,
            }).pipe(
              Effect.catchAllCause((cause) =>
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

    const supersedeWalkthrough = (oldId: string, newId: string) =>
      Effect.gen(function* () {
        yield* provideDb(walkthroughService.supersede(oldId, newId));
        // Notify any tab still observing `oldId` so it knows to clear the
        // walkthrough view and re-fetch the replacement. emitEvent resolves
        // the broadcast target from DB if the old job has already left the
        // registry (typical: supersede runs after the fiber tore down).
        yield* emitEvent(oldId, {
          type: "lifecycle:superseded",
          data: { walkthroughId: oldId, supersededBy: newId },
        }).pipe(Effect.catchAll(() => Effect.void));
      });

    const supersedeForPr = (prId: string, exceptHeadSha?: string) =>
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
          if (exceptHeadSha !== undefined && job.prHeadSha === exceptHeadSha) {
            continue;
          }
          supersededIds.push(job.walkthroughId);
          yield* cancel(job.walkthroughId);
        }
        yield* provideDb(walkthroughService.supersedeAllForPr(prId, exceptHeadSha));
        for (const id of supersededIds) {
          yield* emitEvent(id, {
            type: "lifecycle:superseded",
            data: { walkthroughId: id, supersededBy: null },
          }).pipe(Effect.catchAll(() => Effect.void));
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
      return Effect.try({
        try: () =>
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
        catch: (cause) => new DbError({ message: "resolveEventTargets failed", cause }),
      }).pipe(
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
      Effect.withSpan("WalkthroughJobs.emitEvent", {
        attributes: { walkthroughId, eventType: event.type },
      })(
        Effect.gen(function* () {
          // 1. Bump the per-walkthrough seq counter atomically in DB. This
          //    is the authoritative wire seq stamped onto every envelope —
          //    survives kill -9, resumes, chat edits after completion.
          //    Decoupled from the registry so chat-edits on completed
          //    walkthroughs (no fiber) still get correct cursors.
          const seq = yield* provideDb(walkthroughService.bumpSeq(walkthroughId));

          // 2. Look up the active job for the legacy SSE fanOut + targets.
          const map = yield* Ref.get(registry);
          const activeJob = map.get(walkthroughId);

          // 3. Resolve broadcast targets (fast path = in-memory job, slow
          //    path = DB join for chat-edit-on-completed-walkthrough).
          const targets = yield* resolveEventTargets(walkthroughId, activeJob);
          if (targets !== null) {
            // Broadcaster fan-out — the new SSE path. Account-scoped so a
            // multi-account user only sees their own walkthrough events.
            yield* broadcaster
              .broadcastToAccount(targets.accountId, {
                type: "walkthrough:event",
                data: {
                  prId: targets.prId,
                  walkthroughId,
                  seq,
                  event,
                },
              })
              .pipe(Effect.catchAll(() => Effect.void));
          } else {
            debug(
              "wt-trace",
              `emitEvent-no-target wt=${walkthroughId} type=${event.type} (walkthrough row missing)`,
            );
          }

          // 4. Legacy fanOut for the per-PR SSE handler. During the dual-emit
          //    window both paths are active; the legacy SSE handler is deleted
          //    once the client cutover lands (step 7 of the plan).
          if (activeJob) {
            subscribers.fanOut(activeJob.walkthroughId, activeJob, event);
          } else {
            debug(
              "wt-trace",
              `emitEvent-no-job wt=${walkthroughId} type=${event.type} (chat-edit or post-completion path)`,
            );
          }

          // 5. Refresh opencode stream-guard inactivity timer (unchanged).
          //    Skip when the event being emitted is itself `thinking` — that's
          //    already the heartbeat shape. Self-notifying would amplify into an
          //    infinite loop via the consumer at processEvent (defense-in-depth
          //    with the early-return on `thinking` there).
          if (event.type !== "thinking") {
            const notifiers = yield* Ref.get(activityNotifiers);
            const notify = notifiers.get(walkthroughId);
            if (notify) {
              try {
                notify({ type: "thinking", data: {} });
              } catch {
                /* notifier threw — ignore */
              }
            }
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
        return {
          walkthroughId: payload.walkthroughId,
          prId: job.prId,
          accountId: job.accountId,
        };
      });

    const clearSessionToken = (token: string) => sessionStore.clear(token);

    const incrementPrerenderFailures = (walkthroughId: string) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(registry);
        const job = map.get(walkthroughId);
        if (job) {
          job.prerenderFailures += 1;
          debug(
            "walkthrough-jobs",
            `prerender-failure-count wt=${walkthroughId} total=${job.prerenderFailures}`,
          );
        }
      });

    const tryHydrateFromRemoteCache = (
      prId: string,
      headSha: string,
      repoFullName: string,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const settings = yield* settingsService
          .getSettings()
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
        if (!settings?.cache.enabled || !settings.cache.downloadsEnabled) return false;

        const snapshotOpt = yield* remoteCache.fetch(repoFullName, headSha);
        if (Option.isNone(snapshotOpt)) return false;

        const snapshot = snapshotOpt.value;

        const reviewSession = yield* provideDb(reviewService.getOrCreateActiveSession(prId));
        const walkthroughId = yield* provideDb(
          walkthroughService.createPartial({
            reviewSessionId: reviewSession.id,
            prId,
            modelUsed: snapshot.modelUsed,
            prHeadSha: headSha,
            generatedBy: snapshot.generatedBy,
            providerConfig: snapshot.providerConfig,
          }),
        );

        const importResult = yield* provideDb(
          snapshotImporter.import({ walkthroughId, snapshot }),
        ).pipe(Effect.either);

        if (importResult._tag === "Left") {
          logError(
            "walkthrough-jobs",
            `tryHydrateFromRemoteCache import failed pr=${prId}: ${importResult.left.reason}`,
          );
          return false;
        }

        yield* setStatus(walkthroughId, "complete");
        // New SSE bus only. Clients re-hydrate via `/current` to fetch the
        // imported content; replay-as-events is a follow-up improvement.
        yield* emitEvent(walkthroughId, {
          type: "lifecycle:cache-hit",
          data: { walkthroughId, source: "remote" },
        }).pipe(Effect.catchAll(() => Effect.void));
        yield* emitEvent(walkthroughId, {
          type: "lifecycle:complete",
          data: {
            walkthroughId,
            tokenUsage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          },
        }).pipe(Effect.catchAll(() => Effect.void));

        debug(
          "walkthrough-jobs",
          `tryHydrateFromRemoteCache hit wt=${walkthroughId} pr=${prId} sha=${headSha}`,
        );
        return true;
      }).pipe(
        Effect.catchAll((e) => {
          logError(
            "walkthrough-jobs",
            `tryHydrateFromRemoteCache failed pr=${prId}: ${e instanceof Error ? e.message : String(e)}`,
          );
          return Effect.succeed(false);
        }),
      );

    return {
      startJob,
      subscribe,
      findActiveByPr,
      cancel,
      reviveFromError,
      resumePending,
      supersedeWalkthrough,
      supersedeForPr,
      emitEvent,
      issueSessionToken,
      resolveSessionToken,
      clearSessionToken,
      incrementPrerenderFailures,
      registerActivityNotifier,
      unregisterActivityNotifier,
      tryHydrateFromRemoteCache,
    };
  }),
);
