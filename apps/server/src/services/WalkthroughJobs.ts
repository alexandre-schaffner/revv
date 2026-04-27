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
  Walkthrough,
  WalkthroughStatus,
  WalkthroughStreamEvent,
  WalkthroughTokenUsage,
} from "@revv/shared";
import {
  Cause,
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  type Scope,
} from "effect";
import {
  type AiError,
  AiGenerationError,
  type CloneError,
  CloneInProgressError,
  CloneNotReadyError,
  type GitHubError,
  type NotFoundError,
  type ReviewError,
  type ValidationError,
} from "../domain/errors";
import { withDb } from "../effects/with-db";
import { debug, type LogContext, logError, withLogContext } from "../logger";
import { AiService, type ContinuationContext, resolveAgent } from "./Ai";
import { DbService } from "./Db";
import { GitHubEtagCache } from "./GitHubEtagCache";
import { PrContextService } from "./PrContext";
import { RepoCloneService } from "./RepoClone";
import { ReviewService } from "./Review";
import { SettingsService } from "./Settings";
import { WalkthroughService } from "./Walkthrough";
import { WebSocketHub } from "./WebSocketHub";

// ── Constants ────────────────────────────────────────────────────────────────

/** Cap on concurrent walkthrough fibers. Additional jobs queue on the semaphore. */
export const MAX_CONCURRENT_JOBS = 5;

/**
 * Soft cap on how many times a single walkthrough row will be re-launched
 * across server restarts. After this many attempts the row is marked `error`
 * and no further resume fiber is spawned.
 */
export const WALKTHROUGH_MAX_RESUME_ATTEMPTS = 3;

/**
 * Maximum number of automatic in-flight continuations when the AI generator
 * exits without reaching Phase D (all 9 axes rated). Capped to prevent
 * infinite loops if the model persistently fails.
 */
export const MAX_AUTO_CONTINUATIONS = 2;

/** Opaque session token TTL for the HTTP MCP route — jobs usually finish well under this. */
export const SESSION_TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour

// ── Types ────────────────────────────────────────────────────────────────────

type Subscriber = (event: WalkthroughStreamEvent) => void;

interface SubscriberHandle {
  readonly callback: Subscriber;
  /** Buffer for pre-flush events. `null` after flush (direct-forward mode). */
  buffered: WalkthroughStreamEvent[] | null;
}

interface ActiveJob {
  readonly walkthroughId: string;
  readonly prId: string;
  readonly prHeadSha: string;
  readonly userId: string;
  readonly abortController: AbortController;
  readonly subscribers: Set<SubscriberHandle>;
  fiber: Fiber.RuntimeFiber<unknown, unknown> | null;
  cancelledByUser: boolean;
}

export interface SessionTokenEntry {
  readonly walkthroughId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type StartJobTrigger = "user" | "resume";

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

    readonly subscribe: (
      walkthroughId: string,
      onEvent: Subscriber,
    ) => Effect.Effect<SubscribeResult>;

    readonly findActiveByPr: (prId: string) => Effect.Effect<{
      readonly walkthroughId: string;
      readonly prHeadSha: string;
    } | null>;

    readonly cancel: (walkthroughId: string) => Effect.Effect<void>;

    readonly resumePending: () => Effect.Effect<void>;

    /**
     * Supersede one walkthrough with another (both for the same PR but
     * different head SHAs). Called by PollScheduler when a new commit
     * arrives. Per doctrine invariant #7, the old row is marked
     * 'superseded' rather than mutated in place.
     */
    readonly supersedeWalkthrough: (
      oldId: string,
      newId: string,
    ) => Effect.Effect<void>;

    /**
     * Cancel any in-flight job for a PR and mark all existing walkthroughs
     * 'superseded'. Used when PollScheduler detects a head-SHA change —
     * the old work is frozen in place (immutable per SHA, invariant #7)
     * and the next user interaction triggers a fresh walkthrough for the
     * new SHA.
     */
    readonly supersedeForPr: (prId: string) => Effect.Effect<void>;

    /**
     * Fan an event out to a running job's subscribers. The primary caller
     * is the HTTP MCP route — when opencode makes a tool call against
     * `/mcp/walkthrough`, the handler commits to DB then invokes this to
     * broadcast the resulting event. No-op if no active job.
     */
    readonly emitEvent: (
      walkthroughId: string,
      event: WalkthroughStreamEvent,
    ) => Effect.Effect<void>;

    /**
     * Issue an opaque session token for the HTTP MCP route. Tokens resolve
     * to a walkthroughId and are valid only while the job is running. The
     * token is cleared automatically on scope close.
     */
    readonly issueSessionToken: (
      walkthroughId: string,
    ) => Effect.Effect<string>;

    /**
     * Resolve a session token. Returns null if expired or unknown, or if
     * the job is no longer running. Used by the HTTP MCP route to
     * authenticate incoming tool calls from the opencode daemon.
     */
    readonly resolveSessionToken: (token: string) => Effect.Effect<{
      readonly walkthroughId: string;
      readonly prId: string;
    } | null>;

    /** Invalidate a session token early (e.g. on job cancel). */
    readonly clearSessionToken: (token: string) => Effect.Effect<void>;
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
    const hub = yield* WebSocketHub;

    const registry = yield* Ref.make(new Map<string, ActiveJob>());
    const semaphore = yield* Effect.makeSemaphore(MAX_CONCURRENT_JOBS);

    // Opaque-token → walkthroughId map. Ephemeral coordination (invariant #1):
    // tokens are never persisted; on restart they're regenerated by the
    // resume path. The HTTP MCP route resolves against this map.
    const sessionTokens = yield* Ref.make(new Map<string, SessionTokenEntry>());

    const provideInfra = <A, E>(
      eff: Effect.Effect<A, E, DbService | GitHubEtagCache>,
    ): Effect.Effect<A, E> =>
      eff.pipe(
        Effect.provideService(DbService, { db }),
        Effect.provideService(GitHubEtagCache, etagCache),
      );

    const provideDb = <A, E>(
      eff: Effect.Effect<A, E, DbService>,
    ): Effect.Effect<A, E> => withDb(db, eff);

    // ── Status chokepoint (invariant #11) ────────────────────────────────
    //
    // Every status transition goes through this single method. Agents never
    // write status; other services call this.
    const setStatus = (
      walkthroughId: string,
      status: WalkthroughStatus,
      options?: { tokenUsage?: WalkthroughTokenUsage },
    ) =>
      provideDb(
        walkthroughService.setStatus(walkthroughId, status, {
          ...(options?.tokenUsage ? { tokenUsage: options.tokenUsage } : {}),
        }),
      );

    // ── Subscriber fan-out ──────────────────────────────────────────────
    //
    // Commit-first / broadcast-second (invariant #8): by the time an event
    // reaches this function, the MCP tool handler (for content events) or
    // the orchestrator itself (for lifecycle events) has already committed
    // the DB write. Broadcast failures here never roll back state — a
    // reconnecting subscriber recovers the truth from DB.
    const fanOut = (job: ActiveJob, event: WalkthroughStreamEvent): void => {
      for (const handle of job.subscribers) {
        try {
          if (handle.buffered !== null) {
            handle.buffered.push(event);
          } else {
            handle.callback(event);
          }
        } catch (err) {
          logError(
            "walkthrough-jobs",
            "subscriber threw:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    };

    const removeJob = (walkthroughId: string) =>
      Ref.update(registry, (map) => {
        if (!map.has(walkthroughId)) return map;
        const next = new Map(map);
        next.delete(walkthroughId);
        return next;
      });

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

    const buildJobBody = (
      job: ActiveJob,
      ctx: ResolvedContext,
    ): Effect.Effect<void, AiError, Scope.Scope> =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (!job.abortController.signal.aborted) {
              debug(
                "walkthrough-jobs",
                "scope closing — aborting AI controller",
              );
              try {
                job.abortController.abort(
                  new Error("Walkthrough job scope closed"),
                );
              } catch {
                /* already aborted — ignore */
              }
            }
          }),
        );

        const worktreePath = yield* repoCloneService
          .acquireWalkthroughWorktree(
            ctx.repoId,
            job.walkthroughId,
            ctx.prHeadSha,
            ctx.token,
            ctx.pr.externalId,
          )
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

        const buildStreamParams = (
          overrideContinuation?: ContinuationContext,
        ) => ({
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
          ...(overrideContinuation
            ? { continuation: overrideContinuation }
            : {}),
          onSessionId: (id: string) => {
            capturedOpencodeSessionId = id;
            Effect.runPromise(
              provideDb(
                walkthroughService.setOpencodeSessionId(job.walkthroughId, id),
              ).pipe(Effect.catchAll(() => Effect.void)),
            ).catch(() => {
              /* ignore */
            });
          },
          abortController: job.abortController,
          // Supply opencode-path session-token callbacks. Ignored by
          // the Claude SDK path. WalkthroughJobs owns the
          // `sessionTokens` ref (see Ref.make below) — passing these
          // through as callbacks avoids a layer-level cycle between
          // AiService and WalkthroughJobs.
          issueOpencodeSessionToken: (walkthroughId: string) =>
            Effect.runPromise(issueSessionToken(walkthroughId)),
          clearOpencodeSessionToken: (token: string) =>
            Effect.runPromise(clearSessionToken(token)),
        });

        if (partial) {
          const continuation: ContinuationContext = {
            walkthroughId: partial.id,
            existingBlocks: partial.blocks,
            existingIssueCount: partial.issues.length,
            existingRatedAxes: partial.ratings.map((r) => r.axis),
            ...(partial.opencodeSessionId
              ? { opencodeSessionId: partial.opencodeSessionId }
              : {}),
          };
          generator = yield* ai.streamWalkthrough(
            buildStreamParams(continuation),
          );
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
        const logCtx: LogContext = {
          walkthroughId: job.walkthroughId,
          prId: ctx.pr.id,
        };

        let autoContinuations = 0;
        let accumulatedTokenUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        };
        let currentGenerator = generator;

        yield* Effect.tryPromise({
          try: () =>
            withLogContext(logCtx, async () => {
              while (true) {
                try {
                  for await (const event of currentGenerator) {
                    debug("walkthrough-jobs", "event:", event.type);

                    if (event.type === "done") {
                      // Accumulate token usage across any
                      // intermediate auto-continuations.
                      accumulatedTokenUsage = {
                        inputTokens:
                          accumulatedTokenUsage.inputTokens +
                          event.data.tokenUsage.inputTokens,
                        outputTokens:
                          accumulatedTokenUsage.outputTokens +
                          event.data.tokenUsage.outputTokens,
                        cacheReadInputTokens:
                          accumulatedTokenUsage.cacheReadInputTokens +
                          event.data.tokenUsage.cacheReadInputTokens,
                        cacheCreationInputTokens:
                          accumulatedTokenUsage.cacheCreationInputTokens +
                          event.data.tokenUsage.cacheCreationInputTokens,
                      };

                      // Consult DB (not event state) for
                      // completion — the agent may have
                      // terminated without calling
                      // complete_walkthrough.
                      const dbState = await Effect.runPromise(
                        provideDb(
                          walkthroughService.getPartial(
                            ctx.pr.id,
                            ctx.prHeadSha,
                          ),
                        ).pipe(Effect.catchAll(() => Effect.succeed(null))),
                      );

                      if (dbState?.lastCompletedPhase === "D") {
                        // Phase D reached — transition to
                        // complete.
                        await Effect.runPromise(
                          setStatus(job.walkthroughId, "complete", {
                            tokenUsage: accumulatedTokenUsage,
                          }),
                        );
                        await Effect.runPromise(
                          hub
                            .broadcast({
                              type: "walkthrough:complete",
                              data: {
                                prId: ctx.pr.id,
                                walkthroughId: job.walkthroughId,
                              },
                            })
                            .pipe(Effect.catchAll(() => Effect.void)),
                        );
                        fanOut(job, {
                          type: "done",
                          data: {
                            walkthroughId: job.walkthroughId,
                            tokenUsage: accumulatedTokenUsage,
                          },
                        });
                        return;
                      }

                      // Phase < D — need to continue if we
                      // have budget.
                      break;
                    }

                    if (event.type === "error") {
                      await Effect.runPromise(
                        setStatus(job.walkthroughId, "error"),
                      );
                      await Effect.runPromise(
                        hub
                          .broadcast({
                            type: "walkthrough:error",
                            data: {
                              prId: ctx.pr.id,
                              message: event.data.message,
                            },
                          })
                          .pipe(Effect.catchAll(() => Effect.void)),
                      );
                      fanOut(job, event);
                      return;
                    }

                    // Every other event just fans out —
                    // content persistence already happened
                    // in the tool handler.
                    fanOut(job, event);
                  }
                } finally {
                  if (capturedOpencodeSessionId !== undefined) {
                    await Effect.runPromise(
                      provideDb(
                        walkthroughService.setOpencodeSessionId(
                          job.walkthroughId,
                          capturedOpencodeSessionId,
                        ),
                      ).pipe(Effect.catchAll(() => Effect.void)),
                    );
                  }
                }

                // ── Auto-continuation check ────────────────
                if (
                  autoContinuations >= MAX_AUTO_CONTINUATIONS ||
                  job.abortController.signal.aborted
                ) {
                  debug(
                    "walkthrough-jobs",
                    "skipping auto-continuation:",
                    autoContinuations >= MAX_AUTO_CONTINUATIONS
                      ? "max continuations reached"
                      : "aborted",
                  );
                  // Mark error if we never reached Phase D — otherwise
                  // the row stays in `generating` forever.
                  const finalState = await Effect.runPromise(
                    provideDb(
                      walkthroughService.getPartial(ctx.pr.id, ctx.prHeadSha),
                    ).pipe(Effect.catchAll(() => Effect.succeed(null))),
                  );
                  if (finalState?.lastCompletedPhase !== "D") {
                    await Effect.runPromise(
                      setStatus(job.walkthroughId, "error"),
                    );
                  }
                  fanOut(job, {
                    type: "done",
                    data: {
                      walkthroughId: job.walkthroughId,
                      tokenUsage: accumulatedTokenUsage,
                    },
                  });
                  return;
                }

                const partialForContinuation = await Effect.runPromise(
                  provideDb(
                    walkthroughService.getPartial(ctx.pr.id, ctx.prHeadSha),
                  ).pipe(Effect.catchAll(() => Effect.succeed(null))),
                );

                if (!partialForContinuation) {
                  debug(
                    "walkthrough-jobs",
                    "auto-continuation: no partial — accepting incomplete",
                  );
                  fanOut(job, {
                    type: "done",
                    data: {
                      walkthroughId: job.walkthroughId,
                      tokenUsage: accumulatedTokenUsage,
                    },
                  });
                  return;
                }

                autoContinuations++;
                debug(
                  "walkthrough-jobs",
                  `auto-continuation ${autoContinuations}/${MAX_AUTO_CONTINUATIONS}: lastCompletedPhase=${partialForContinuation.lastCompletedPhase}`,
                );

                fanOut(job, {
                  type: "phase",
                  data: {
                    phase: "rating",
                    message: `Finishing walkthrough (phase ${partialForContinuation.lastCompletedPhase})...`,
                  },
                });

                const continuationCtx: ContinuationContext = {
                  walkthroughId: partialForContinuation.id,
                  existingBlocks: partialForContinuation.blocks,
                  existingIssueCount: partialForContinuation.issues.length,
                  existingRatedAxes: partialForContinuation.ratings.map(
                    (r) => r.axis,
                  ),
                  ...(partialForContinuation.opencodeSessionId
                    ? {
                        opencodeSessionId:
                          partialForContinuation.opencodeSessionId,
                      }
                    : {}),
                };

                currentGenerator = await Effect.runPromise(
                  ai.streamWalkthrough(buildStreamParams(continuationCtx)),
                );
              }
            }),
          catch: (err) => new AiGenerationError({ cause: err }),
        });
      });

    const launchJob = (job: ActiveJob, ctx: ResolvedContext) =>
      Effect.gen(function* () {
        yield* Ref.update(registry, (map) => {
          const next = new Map(map);
          next.set(job.walkthroughId, job);
          return next;
        });

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

            if (interruptedOnly && !cancelledByUser) {
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
                ? (failureOpt.value as { cause?: unknown }).cause instanceof
                  Error
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

            yield* setStatus(job.walkthroughId, "error").pipe(
              Effect.catchAll(() => Effect.void),
            );

            yield* hub
              .broadcast({
                type: "walkthrough:error",
                data: { prId: job.prId, message },
              })
              .pipe(Effect.catchAll(() => Effect.void));
            fanOut(job, {
              type: "error",
              data: { code, message },
            });
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
            Ref.update(sessionTokens, (map) => {
              let changed = false;
              const next = new Map(map);
              for (const [token, entry] of next.entries()) {
                if (entry.walkthroughId === job.walkthroughId) {
                  next.delete(token);
                  changed = true;
                }
              }
              return changed ? next : map;
            }),
          ),
        );

        const fiber = yield* Effect.forkDaemon(scopedBody);
        job.fiber = fiber as Fiber.RuntimeFiber<unknown, unknown>;
      });

    // ── Public API ──────────────────────────────────────────────────────

    const findActiveByPr = (
      prId: string,
    ): Effect.Effect<{
      readonly walkthroughId: string;
      readonly prHeadSha: string;
    } | null> =>
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
        const existing = yield* findActiveByPr(params.prId);
        if (
          existing !== null &&
          (params.walkthroughId === undefined ||
            params.walkthroughId === existing.walkthroughId)
        ) {
          return { walkthroughId: existing.walkthroughId };
        }

        const resolved = yield* provideInfra(
          prContextService.resolveWithDiff(params.prId, params.userId),
        );
        const { pr, repo, token, meta, files } = resolved;

        const cloneStatus = yield* repoCloneService.getCloneStatus(repo.id);
        if (cloneStatus.status !== "ready") {
          if (cloneStatus.status === "cloning") {
            return yield* Effect.fail(
              new CloneInProgressError({ repoId: repo.id }),
            );
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

        let partial = yield* provideDb(
          walkthroughService.getPartial(pr.id, meta.headSha),
        );
        if (
          params.walkthroughId !== undefined &&
          partial !== null &&
          partial.id !== params.walkthroughId
        ) {
          partial = null;
        }

        const reviewSession = yield* provideDb(
          reviewService.getOrCreateActiveSession(pr.id),
        );
        const reviewSessionId = partial?.reviewSessionId ?? reviewSession.id;

        const settings = yield* provideDb(settingsService.getSettings());
        const agent = resolveAgent(settings);
        const modelUsed =
          partial?.modelUsed && partial.modelUsed !== "unknown"
            ? partial.modelUsed
            : (settings.aiModel ??
              (agent === "opencode" ? "opencode" : "claude-sonnet-4-20250514"));

        // Idempotent row creation (upsert on the new unique index).
        // This is the sole "make a walkthrough row exist" call in the
        // codebase — MCP tool handlers never insert, they only update.
        const walkthroughId = yield* provideDb(
          walkthroughService.createPartial({
            ...((partial?.id ?? params.walkthroughId)
              ? { id: partial?.id ?? params.walkthroughId! }
              : {}),
            reviewSessionId,
            prId: pr.id,
            modelUsed,
            prHeadSha: meta.headSha,
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

        const abortController = new AbortController();
        const job: ActiveJob = {
          walkthroughId,
          prId: pr.id,
          prHeadSha: meta.headSha,
          userId: params.userId,
          abortController,
          subscribers: new Set(),
          fiber: null,
          cancelledByUser: false,
        };

        yield* launchJob(job, {
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
        });

        return { walkthroughId };
      });

    const subscribe = (
      walkthroughId: string,
      onEvent: Subscriber,
    ): Effect.Effect<SubscribeResult> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(registry);
        const job = map.get(walkthroughId);
        if (!job) return { found: false };

        const handle: SubscriberHandle = {
          callback: onEvent,
          buffered: [],
        };
        job.subscribers.add(handle);

        return {
          found: true,
          unsubscribe: () => {
            job.subscribers.delete(handle);
          },
          flush: () => {
            const buf = handle.buffered;
            handle.buffered = null;
            if (buf) {
              for (const event of buf) {
                try {
                  onEvent(event);
                } catch (err) {
                  logError(
                    "walkthrough-jobs",
                    "subscriber flush threw:",
                    err instanceof Error ? err.message : String(err),
                  );
                }
              }
            }
          },
        };
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

    const resumePending = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const rows = yield* provideDb(walkthroughService.listGenerating());
        debug(
          "walkthrough-jobs",
          "resumePending: found",
          rows.length,
          "generating rows",
        );

        for (const row of rows) {
          const attempts = yield* provideDb(
            walkthroughService.incrementResumeAttempts(row.id),
          );
          if (attempts > WALKTHROUGH_MAX_RESUME_ATTEMPTS) {
            debug(
              "walkthrough-jobs",
              "walkthrough",
              row.id,
              "exceeded resume attempts — marking error",
            );
            yield* setStatus(row.id, "error");
            yield* hub
              .broadcast({
                type: "walkthrough:error",
                data: {
                  prId: row.pullRequestId,
                  message:
                    "Walkthrough failed after repeated retries. Try regenerating.",
                },
              })
              .pipe(Effect.catchAll(() => Effect.void));
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
      });

    const supersedeWalkthrough = (oldId: string, newId: string) =>
      provideDb(walkthroughService.supersede(oldId, newId));

    const supersedeForPr = (prId: string) =>
      Effect.gen(function* () {
        // Cancel any in-flight job first so the fiber's scope finalizer
        // runs before we touch the DB row. See regenerateWalkthroughHandler
        // for the same rationale.
        const map = yield* Ref.get(registry);
        for (const job of map.values()) {
          if (job.prId === prId) {
            yield* cancel(job.walkthroughId);
          }
        }
        yield* provideDb(walkthroughService.supersedeAllForPr(prId));
      });

    const emitEvent = (walkthroughId: string, event: WalkthroughStreamEvent) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(registry);
        const job = map.get(walkthroughId);
        if (!job) return;
        fanOut(job, event);
      });

    const issueSessionToken = (walkthroughId: string) =>
      Effect.gen(function* () {
        const token = crypto.randomUUID();
        const now = Date.now();
        yield* Ref.update(sessionTokens, (map) => {
          const next = new Map(map);
          next.set(token, {
            walkthroughId,
            issuedAt: now,
            expiresAt: now + SESSION_TOKEN_TTL_MS,
          });
          return next;
        });
        return token;
      });

    const resolveSessionToken = (token: string) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(sessionTokens);
        const entry = map.get(token);
        if (!entry) return null;
        if (entry.expiresAt < Date.now()) return null;
        const registryMap = yield* Ref.get(registry);
        const job = registryMap.get(entry.walkthroughId);
        if (!job) return null;
        return {
          walkthroughId: entry.walkthroughId,
          prId: job.prId,
        };
      });

    const clearSessionToken = (token: string) =>
      Ref.update(sessionTokens, (map) => {
        if (!map.has(token)) return map;
        const next = new Map(map);
        next.delete(token);
        return next;
      });

    return {
      startJob,
      subscribe,
      findActiveByPr,
      cancel,
      resumePending,
      supersedeWalkthrough,
      supersedeForPr,
      emitEvent,
      issueSessionToken,
      resolveSessionToken,
      clearSessionToken,
    };
  }),
);
