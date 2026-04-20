// ── WalkthroughJobs ────────────────────────────────────────────────────────
// Durable, isolated AI walkthrough generator. Owns:
//   • An in-memory registry of running fibers keyed by walkthroughId.
//   • A shared Semaphore (capacity = MAX_CONCURRENT_JOBS) so a burst of
//     "Regenerate" clicks can't spawn unlimited parallel Claude turns.
//   • Per-job AbortController, wired into the AI provider so cancellation
//     propagates into the underlying Claude SDK turn or `opencode` subprocess.
//   • Per-job scope with a detached `git worktree` pinned at prHeadSha. The
//     scope finalizer removes the worktree + aborts the controller on exit,
//     so crashes, interrupts, and normal completions all clean up.
//
// The SSE handler (walkthrough-stream.ts) is reduced to a thin subscriber:
// it finds (or starts) the job, replays the DB snapshot via getPartial, then
// flushes the subscriber's buffered live events. Events are persisted
// BEFORE being fanned out to subscribers — the DB is the consistent source
// of truth, and late joiners can always catch up via snapshot.

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
import type { Walkthrough, WalkthroughStreamEvent } from "@revv/shared";
import {
	AiGenerationError,
	CloneInProgressError,
	CloneNotReadyError,
	type AiError,
	type CloneError,
	type GitHubError,
	type NotFoundError,
	type ReviewError,
	type ValidationError,
} from "../domain/errors";
import { debug, logError, withLogContext, type LogContext } from "../logger";
import { withDb } from "../effects/with-db";
import { AiService, resolveAgent, type ContinuationContext } from "./Ai";
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
 * and no further resume fiber is spawned — otherwise a persistently-poisoned
 * partial could infinitely eat semaphore permits on every boot.
 */
export const WALKTHROUGH_MAX_RESUME_ATTEMPTS = 3;

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
	/**
	 * Set by {@link cancel}. Distinguishes "user clicked Regenerate" (→ mark
	 * row as error so stale data doesn't resurrect) from "server received
	 * SIGTERM" (→ leave row in `generating` so `resumePending` can reclaim it
	 * on next boot). Both end up interrupting the fiber; only the explicit
	 * flag tells us not to preserve the row.
	 */
	cancelledByUser: boolean;
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
		 * Behavior:
		 *  - If a job for `prId` is already running and the caller hasn't pinned
		 *    a specific `walkthroughId`, the existing job's id is returned and
		 *    no new fiber is spawned.
		 *  - If a partial walkthrough row already exists in DB for the PR's
		 *    current headSha, the job resumes from there (using the AI
		 *    provider's continuation API).
		 *  - Otherwise the job starts fresh; a walkthroughId is pre-minted and
		 *    the DB row is created when the first `summary` event arrives.
		 */
		readonly startJob: (params: {
			readonly prId: string;
			readonly userId: string;
			readonly trigger: StartJobTrigger;
			/** Set by `resumePending` to pin a specific row id. */
			readonly walkthroughId?: string;
		}) => Effect.Effect<{ readonly walkthroughId: string }, StartJobError>;

		/**
		 * Attach an event listener to a running job. Returns a handle with
		 * `flush()` — call it AFTER replaying the DB snapshot to drain any
		 * events that arrived during the snapshot window and switch to
		 * direct forwarding.
		 *
		 * Returns `{ found: false }` if no job exists for that id (either
		 * already finished or never started). Callers should fall back to
		 * DB read in that case.
		 */
		readonly subscribe: (
			walkthroughId: string,
			onEvent: Subscriber,
		) => Effect.Effect<SubscribeResult>;

		/** Find a currently-running job for a PR. */
		readonly findActiveByPr: (
			prId: string,
		) => Effect.Effect<
			{ readonly walkthroughId: string; readonly prHeadSha: string } | null
		>;

		/**
		 * Cancel a running job: signals the AbortController (kills the child
		 * Claude turn / opencode subprocess), then interrupts the Fiber and
		 * awaits its exit so scope finalizers run before we return.
		 */
		readonly cancel: (walkthroughId: string) => Effect.Effect<void>;

		/**
		 * Re-launch jobs for any `status='generating'` walkthrough rows left
		 * stranded by a previous server run. Each resume is capped by
		 * {@link WALKTHROUGH_MAX_RESUME_ATTEMPTS}; exceeded rows are marked
		 * `error` so clients stop waiting.
		 */
		readonly resumePending: () => Effect.Effect<void>;
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
		// ── Capture deps (all plain values after yield*) ────────────────────
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

		// Provide the captured `db` + `etagCache` to any inner Effect that
		// declares those services in R. Mirrors the PollScheduler pattern so
		// public service methods stay R=never.
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

		// ── Subscriber fan-out ──────────────────────────────────────────────
		// Buggy subscribers can't be allowed to break siblings — wrap each
		// dispatch in try/catch. Pre-flush subscribers stash events in a
		// local buffer; `flush()` drains the buffer in order, then switches
		// the handle into direct-forward mode.
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
		// Runs inside Effect.scoped so finalizers (worktree cleanup, abort
		// signal) fire on success, error, OR interrupt. Returns an Effect
		// that requires a Scope — the caller composes it with Effect.scoped.
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
				// Finalizer: on ANY scope close (success, failure, interrupt),
				// ensure the controller is aborted so downstream async work
				// (the AI provider, its subprocess, MCP client) notices and
				// tears down cleanly. Safe to call twice — the std AbortController
				// is idempotent, but we still guard to avoid spurious log noise.
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

				// Acquire a dedicated, detached worktree pinned to the exact SHA.
				// Registers its own scope finalizer to `git worktree remove --force`.
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
						e._tag === 'CloneNotReadyError'
							? `Repository clone is not ready — check Settings to ensure the repo is cloned`
							: e._tag === 'CloneError'
								? `Repository clone error: ${e.message}`
								: String(e);
					return new AiGenerationError({ cause: e, message });
				}),
			);

				// Build the underlying AI generator (resume or fresh).
				const partial = ctx.partial;
				let generator: AsyncGenerator<WalkthroughStreamEvent>;
				let resumeFromBlockCount = 0;
				let capturedOpencodeSessionId: string | undefined;

				if (partial) {
					resumeFromBlockCount = partial.blocks.length;
					const continuation: ContinuationContext = {
						walkthroughId: partial.id,
						existingBlocks: partial.blocks,
						existingIssueCount: partial.issues.length,
						existingRatedAxes: partial.ratings.map((r) => r.axis),
						...(partial.opencodeSessionId
							? { opencodeSessionId: partial.opencodeSessionId }
							: {}),
					};
					generator = yield* ai.streamWalkthrough({
						pr: {
							title: ctx.pr.title,
							body: ctx.pr.body,
							sourceBranch: ctx.pr.sourceBranch,
							targetBranch: ctx.pr.targetBranch,
							url: ctx.pr.url,
						},
						files: ctx.files as never,
						worktreePath,
						continuation,
						onSessionId: (id) => {
							capturedOpencodeSessionId = id;
						},
						abortController: job.abortController,
					});
				} else {
					generator = yield* ai.streamWalkthrough({
						pr: {
							title: ctx.pr.title,
							body: ctx.pr.body,
							sourceBranch: ctx.pr.sourceBranch,
							targetBranch: ctx.pr.targetBranch,
							url: ctx.pr.url,
						},
						files: ctx.files as never,
						worktreePath,
						abortController: job.abortController,
					});
				}

				// ── Event loop ──────────────────────────────────────────────
				// `localWalkthroughId` is null for fresh jobs until the first
				// summary arrives, at which point we insert the row using the
				// pre-minted id so subscribers that queried by this id find the
				// persisted state.
				let localWalkthroughId: string | null = partial?.id ?? null;
				let issueOrderCounter = 0;
				// Issue orders on resume: new issues start after the existing ones.
				const issueOrderOffset = partial?.issues.length ?? 0;

				// Compose a ready-to-run Effect that persists a single event +
				// fans it out. Uses the captured service closure so nothing
				// needs to be re-yielded per event.
				const persistAndFanout = (
					event: WalkthroughStreamEvent,
				): Effect.Effect<void> =>
					Effect.gen(function* () {
						debug("walkthrough-jobs", "event:", event.type);

						if (event.type === "summary") {
							if (localWalkthroughId === null) {
								yield* provideDb(
									walkthroughService.createPartial({
										id: job.walkthroughId,
										reviewSessionId: ctx.reviewSessionId,
										prId: ctx.pr.id,
										summary: event.data.summary,
										riskLevel: event.data.riskLevel,
										modelUsed: ctx.modelUsed,
										prHeadSha: ctx.prHeadSha,
									}),
								).pipe(
									Effect.catchAll((err) =>
										Effect.sync(() => {
											logError(
												"walkthrough-jobs",
												"createPartial failed:",
												err,
											);
										}),
									),
								);
								localWalkthroughId = job.walkthroughId;
							}
						} else if (
							event.type === "block" &&
							localWalkthroughId !== null
						) {
							// Skip re-persisting blocks already captured in a
							// previous partial. The AI provider's continuation
							// emitter is seeded with blockCount so new blocks
							// start at `resumeFromBlockCount`; anything below
							// that is a replay (shouldn't happen with the new
							// subscribe-from-DB flow, but defend anyway).
							const isReplayed =
								event.data.order < resumeFromBlockCount;
							if (!isReplayed) {
								yield* provideDb(
									walkthroughService.addBlock(
										localWalkthroughId,
										event.data,
									),
								).pipe(
									Effect.catchAll((err) =>
										Effect.sync(() => {
											logError(
												"walkthrough-jobs",
												"addBlock failed:",
												err,
											);
										}),
									),
								);
							}
						} else if (
							event.type === "issue" &&
							localWalkthroughId !== null
						) {
							const order = issueOrderOffset + issueOrderCounter;
							issueOrderCounter++;
							yield* provideDb(
								walkthroughService.addIssue(
									localWalkthroughId,
									event.data,
									order,
								),
							).pipe(
								Effect.catchAll((err) =>
									Effect.sync(() => {
										logError(
											"walkthrough-jobs",
											"addIssue failed:",
											err,
										);
									}),
								),
							);
						} else if (
							event.type === "rating" &&
							localWalkthroughId !== null
						) {
							yield* provideDb(
								walkthroughService.addRating(
									localWalkthroughId,
									event.data,
								),
							).pipe(
								Effect.catchAll((err) =>
									Effect.sync(() => {
										logError(
											"walkthrough-jobs",
											"addRating failed:",
											err,
										);
									}),
								),
							);
						} else if (
							event.type === "done" &&
							localWalkthroughId !== null
						) {
							yield* provideDb(
								walkthroughService.markComplete(
									localWalkthroughId,
									event.data.tokenUsage,
								),
							).pipe(
								Effect.catchAll((err) =>
									Effect.sync(() => {
										logError(
											"walkthrough-jobs",
											"markComplete failed:",
											err,
										);
									}),
								),
							);
							yield* hub
								.broadcast({
									type: "walkthrough:complete",
									data: {
										prId: ctx.pr.id,
										walkthroughId: localWalkthroughId,
									},
								})
								.pipe(Effect.catchAll(() => Effect.void));
							// Overwrite the provider's empty walkthroughId so
							// subscribers see the correct row id in `done`.
							fanOut(job, {
								type: "done",
								data: {
									walkthroughId: localWalkthroughId,
									tokenUsage: event.data.tokenUsage,
								},
							});
							return;
						} else if (event.type === "error") {
							if (localWalkthroughId !== null) {
								yield* provideDb(
									walkthroughService.markError(localWalkthroughId),
								);
							}
							yield* hub
								.broadcast({
									type: "walkthrough:error",
									data: {
										prId: ctx.pr.id,
										message: event.data.message,
									},
								})
								.pipe(Effect.catchAll(() => Effect.void));
							fanOut(job, event);
							return;
						}

						fanOut(job, event);
					});

				// Consume the generator inside AsyncLocalStorage so any `debug()`
				// / `logError()` calls from nested (non-Effect) provider code
				// automatically inherit the job's log context.
				const logCtx: LogContext = {
					walkthroughId: job.walkthroughId,
					prId: ctx.pr.id,
				};
				yield* Effect.tryPromise({
					try: () =>
						withLogContext(logCtx, async () => {
							try {
								for await (const event of generator) {
									await Effect.runPromise(persistAndFanout(event));
								}
							} finally {
								// Best-effort: persist the opencode session id once
								// the generator terminates, so future resumes of
								// this walkthrough can continue the same session.
								if (
									capturedOpencodeSessionId !== undefined &&
									localWalkthroughId !== null
								) {
									await Effect.runPromise(
										provideDb(
											walkthroughService.setOpencodeSessionId(
												localWalkthroughId,
												capturedOpencodeSessionId,
											),
										).pipe(Effect.catchAll(() => Effect.void)),
									);
								}
							}
						}),
					catch: (err) => new AiGenerationError({ cause: err }),
				});
			});

		// Launch: register the job, fork its scoped fiber, hook cleanup.
		// Error events are synthesized for subscribers on unhandled failure so
		// clients always see a terminal event rather than hanging forever.
		const launchJob = (job: ActiveJob, ctx: ResolvedContext) =>
			Effect.gen(function* () {
				yield* Ref.update(registry, (map) => {
					const next = new Map(map);
					next.set(job.walkthroughId, job);
					return next;
				});

				// Handle all non-success exits: real failure, explicit cancel,
				// or a bare interrupt (e.g. server shutdown). Branches decide
				// whether to mark the DB row as error (which suppresses future
				// resume) and whether to fan out a terminal event to subscribers.
				const handleFailure = (cause: Cause.Cause<AiError>) =>
					Effect.gen(function* () {
						const interruptedOnly = Cause.isInterruptedOnly(cause);
						const cancelledByUser = job.cancelledByUser;

						if (!interruptedOnly) {
					logError(
							"walkthrough-jobs",
							"job failed:",
							Cause.pretty(cause),
						);
					const failure = Cause.failureOption(cause);
					if (Option.isSome(failure)) {
						const err = failure.value;
						// AiGenerationError has typed .message and .cause fields
						const aiErr = err as { _tag: string; message?: string; cause?: unknown };
						const tag = aiErr._tag ?? 'unknown';
						const msg = aiErr.message ?? null;
						const detail = aiErr.cause instanceof Error
							? aiErr.cause.message
							: aiErr.cause != null
								? String(aiErr.cause)
								: null;
						logError(
							"walkthrough-jobs",
							"error detail:",
							[tag, msg, detail].filter(Boolean).join(' — '),
						);
					}

						// Log defects (unhandled thrown exceptions — not typed failures)
						const defect = Cause.defects(cause);
						if (defect.length > 0) {
							for (const d of defect) {
								logError(
									"walkthrough-jobs",
									"defect:",
									d instanceof Error
										? `${d.constructor.name}: ${d.message}\n${d.stack ?? ''}`
										: JSON.stringify(d, null, 2),
								);
							}
						}
						}

						// Server-shutdown interrupt (no user cancel) — PRESERVE
						// the `generating` row so `resumePending` can reclaim
						// it on next boot. We still want the fiber to exit
						// cleanly via scope finalizers, but we skip DB/WS side
						// effects so nothing contradicts the resume.
						if (interruptedOnly && !cancelledByUser) {
							debug(
								"walkthrough-jobs",
								"job interrupted (likely shutdown) — leaving row for resume:",
								job.walkthroughId,
							);
							return;
						}

						// Extract a user-facing message. For explicit cancel we
						// stamp a distinctive code so the UI can differentiate.
						const failureOpt = Cause.failureOption(cause);
						const message = cancelledByUser
							? "Walkthrough cancelled"
							: failureOpt._tag === "Some"
								? (failureOpt.value as { cause?: unknown }).cause instanceof Error
									? ((failureOpt.value as { cause: Error }).cause.message)
									: String(
											(failureOpt.value as { cause?: unknown }).cause ??
												failureOpt.value,
										)
								: "Walkthrough generation failed";
						const code = cancelledByUser ? "Cancelled" : "AiGenerationError";

						// Mark DB row as error. For cancelled jobs the caller
						// (regenerate) is about to invalidateForPr anyway; for
						// real failures this prevents the row from sticking in
						// `generating` forever.
						yield* provideDb(
							walkthroughService.markError(job.walkthroughId),
						).pipe(Effect.catchAll(() => Effect.void));

						yield* hub
							.broadcast({
								type: "walkthrough:error",
								data: { prId: job.prId, message },
							})
							.pipe(Effect.catchAll(() => Effect.void));
						fanOut(job, { type: "error", data: { code, message } });
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
				);

				// forkDaemon: detach from the current scope so the caller's
				// Effect.gen block returns immediately after registration.
				// The job outlives the startJob invocation and only dies via
				// natural completion or explicit `cancel()`.
				const fiber = yield* Effect.forkDaemon(scopedBody);
				job.fiber = fiber as Fiber.RuntimeFiber<unknown, unknown>;
			});

		// ── Public API ──────────────────────────────────────────────────────

		const findActiveByPr = (
			prId: string,
		): Effect.Effect<
			{ readonly walkthroughId: string; readonly prHeadSha: string } | null
		> =>
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
				// Fast path: a job is already running for this PR. Caller that
				// didn't pin a walkthroughId just wants the current one. Caller
				// that pinned a mismatched id falls through to the full flow
				// (shouldn't normally happen — different SHA implies different
				// row — but let it proceed rather than silently swap).
				const existing = yield* findActiveByPr(params.prId);
				if (
					existing !== null &&
					(params.walkthroughId === undefined ||
						params.walkthroughId === existing.walkthroughId)
				) {
					return { walkthroughId: existing.walkthroughId };
				}

				// Resolve the PR context (DB + GitHub API).
				const resolved = yield* provideInfra(
					prContextService.resolveWithDiff(params.prId, params.userId),
				);
				const { pr, repo, token, meta, files } = resolved;

			// Pre-flight: ensure the repo clone is ready before launching the job.
			// Failing here surfaces a synchronous StartJobError that the SSE handler
			// can forward to the UI immediately — no race between job failure and subscribe.
			const cloneStatus = yield* repoCloneService.getCloneStatus(repo.id);
			if (cloneStatus.status !== 'ready') {
				if (cloneStatus.status === 'cloning') {
					return yield* Effect.fail(new CloneInProgressError({ repoId: repo.id }));
				}
				const message = cloneStatus.status === 'error'
					? `Repository clone failed: ${cloneStatus.error ?? 'unknown error'} — check Settings`
					: 'Repository has not been cloned yet — check Settings';
				return yield* Effect.fail(
					new AiGenerationError({ cause: new CloneNotReadyError({ repoId: repo.id }), message }),
				);
			}

				// Look for a partial. If the caller pinned a walkthroughId but
				// the partial's id doesn't match, we're in a stale-resume case
				// — treat as fresh (the stale partial will be cleaned up when
				// a new row is inserted with a different id on summary).
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

				// Pre-mint the id so subscribers have a stable key even for
				// fresh jobs (row doesn't exist until summary event arrives).
				const walkthroughId =
					partial?.id ?? params.walkthroughId ?? crypto.randomUUID();

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
							(agent === "opencode"
								? "opencode"
								: "claude-sonnet-4-20250514"));

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
						// Switch to direct-forward mode FIRST so events arriving
						// during the drain don't skip the buffer and re-order.
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
				// Mark BEFORE aborting so the fiber's failure handler sees
				// the flag even if the abort triggers an error event before
				// interrupt reaches the for-await loop.
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
					// Await ensures scope finalizers (worktree cleanup, etc.)
					// complete before control returns to the caller. Regenerate
					// relies on this: it must know the old job is fully dead
					// before invalidateForPr deletes rows.
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
					// Increment BEFORE attempting resume so a boot loop can't
					// hide itself — if resume crashes the server, the counter
					// is already persisted.
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
						yield* provideDb(walkthroughService.markError(row.id));
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

					// Resume runs with single-user context. Errors are logged
					// but don't abort the loop — one bad row shouldn't block
					// the rest from resuming.
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

		return {
			startJob,
			subscribe,
			findActiveByPr,
			cancel,
			resumePending,
		};
	}),
);
