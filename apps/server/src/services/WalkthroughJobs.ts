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
import type {
	Walkthrough,
	WalkthroughStatus,
	WalkthroughStreamEvent,
	WalkthroughTokenUsage,
} from "@revv/shared";
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
import { findIssuesMissingInlineComment } from "../ai/providers/walkthrough-tools";
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

		readonly subscribe: (
			walkthroughId: string,
			onEvent: Subscriber,
		) => Effect.Effect<SubscribeResult>;

		readonly findActiveByPr: (
			prId: string,
		) => Effect.Effect<
			{ readonly walkthroughId: string; readonly prHeadSha: string } | null
		>;

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
		readonly reviveFromError: (
			walkthroughId: string,
		) => Effect.Effect<void>;

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
		) => Effect.Effect<void>;

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
		readonly resolveSessionToken: (
			token: string,
		) => Effect.Effect<
			| {
					readonly walkthroughId: string;
					readonly prId: string;
			  }
			| null
		>;

		/** Invalidate a session token early (e.g. on job cancel). */
		readonly clearSessionToken: (token: string) => Effect.Effect<void>;

		/**
		 * Register a callback that fires whenever emitEvent is called for the given
		 * walkthroughId. Used by the opencode provider to keep the stream guard's
		 * inactivity timer alive during MCP tool calls. Pure side-effect — never
		 * throws, no-op if already registered (last writer wins).
		 */
		readonly registerActivityNotifier: (
			walkthroughId: string,
			callback: (event: WalkthroughStreamEvent) => void,
		) => Effect.Effect<void>;

		/** Remove the activity notifier for a walkthroughId. No-op if not present. */
		readonly unregisterActivityNotifier: (
			walkthroughId: string,
		) => Effect.Effect<void>;
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
		// for *different* PRs still run in parallel.
		const startJobMutexes = yield* Ref.make(
			new Map<string, Effect.Semaphore>(),
		);

		const acquireStartJobMutex = (
			prId: string,
		): Effect.Effect<Effect.Semaphore> =>
			Effect.gen(function* () {
				// Fast path: a mutex for this PR already exists.
				const cached = (yield* Ref.get(startJobMutexes)).get(prId);
				if (cached) return cached;
				// Slow path: build a candidate, then atomically install it
				// or yield to the racing winner inside `Ref.modify`.
				const candidate = yield* Effect.makeSemaphore(1);
				return yield* Ref.modify(startJobMutexes, (map) => {
					const winner = map.get(prId);
					if (winner) return [winner, map];
					const next = new Map(map);
					next.set(prId, candidate);
					return [candidate, next];
				});
			});

		// Opaque-token → walkthroughId map. Ephemeral coordination (invariant #1):
		// tokens are never persisted; on restart they're regenerated by the
		// resume path. The HTTP MCP route resolves against this map.
		const sessionTokens = yield* Ref.make(
			new Map<string, SessionTokenEntry>(),
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
					...(options?.tokenUsage
						? { tokenUsage: options.tokenUsage }
						: {}),
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
			Effect.all([
				Ref.update(registry, (map) => {
					if (!map.has(walkthroughId)) return map;
					const next = new Map(map);
					next.delete(walkthroughId);
					return next;
				}),
				unregisterActivityNotifier(walkthroughId),
			], { discard: true });

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
					...(overrideContinuation ? { continuation: overrideContinuation } : {}),
					onSessionId: (id: string) => {
						capturedOpencodeSessionId = id;
						Effect.runPromise(
							provideDb(
								walkthroughService.setOpencodeSessionId(
									job.walkthroughId,
									id,
								),
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
					registerOpencodeActivityNotifier: (walkthroughId: string, callback: (event: WalkthroughStreamEvent) => void) =>
						Effect.runPromise(registerActivityNotifier(walkthroughId, callback)),
					unregisterOpencodeActivityNotifier: (walkthroughId: string) =>
						Effect.runPromise(unregisterActivityNotifier(walkthroughId)),
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
										debug(
											"walkthrough-jobs",
											"event:",
											event.type,
										);

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
													event.data.tokenUsage
														.cacheReadInputTokens,
												cacheCreationInputTokens:
													accumulatedTokenUsage.cacheCreationInputTokens +
													event.data.tokenUsage
														.cacheCreationInputTokens,
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
												).pipe(
													Effect.catchAll(() =>
														Effect.succeed(null),
													),
												),
											);

											if (
												dbState?.lastCompletedPhase === "D"
											) {
												// Phase D reached — but Phase D is a
												// NECESSARY, not SUFFICIENT, condition
												// for `complete`. The comment-pairing
												// invariant (warning/critical
												// line-anchored issues must each have
												// ≥1 inline comment, doctrine #12)
												// also has to hold — otherwise the
												// agent could finish all 9 axes and
												// silently leave the coder with no
												// inline review comments at the spots
												// that matter.
												//
												// Same query `complete_walkthrough`
												// runs at the tool surface — kept in
												// the shared utility so both gates
												// can never drift apart.
												const missingComments =
													findIssuesMissingInlineComment(
														db,
														job.walkthroughId,
													);
												if (missingComments.length === 0) {
													await Effect.runPromise(
														setStatus(
															job.walkthroughId,
															"complete",
															{
																tokenUsage:
																	accumulatedTokenUsage,
															},
														),
													);
													await Effect.runPromise(
														hub
															.broadcast({
																type: "walkthrough:complete",
																data: {
																	prId: ctx.pr.id,
																	walkthroughId:
																		job.walkthroughId,
																},
															})
															.pipe(
																Effect.timeout(
																	"5 seconds",
																),
																Effect.catchAll(
																	() => Effect.void,
																),
															),
													);
													fanOut(job, {
														type: "done",
														data: {
															walkthroughId:
																job.walkthroughId,
															tokenUsage:
																accumulatedTokenUsage,
														},
													});
													return;
												}
												debug(
													"walkthrough-jobs",
													`phase=D but ${missingComments.length} warning/critical issue(s) missing inline comment(s) — falling through to auto-continuation:`,
													missingComments
														.map(
															(i) =>
																`${i.id}[${i.severity}]@${i.filePath}:${i.startLine}`,
														)
														.join(", "),
												);
												// Fall through into auto-continuation
												// just as if Phase D had not been
												// reached — same budget, same
												// re-prompt path. The agent's first
												// call on resume is
												// get_walkthrough_state, which
												// surfaces `issuesNeedingInlineComment`
												// explicitly so the model knows what
												// to fix.
												break;
											}

											// Phase < D — need to continue if we
											// have budget.
											break;
										}

										if (event.type === "error") {
											// Suppress error surfacing when the abort
											// came from us (user-clicked Pull /
											// Regenerate, scope close, shutdown). The
											// Claude SDK's catch path emits the
											// generic "Claude Code process aborted by
											// user" string, and a global WS broadcast
											// of that message races with the next SSE
											// the user opens — stamping a misleading
											// error onto the freshly-created
											// walkthrough entry. supersedeForPr is
											// already in flight to mark the row
											// 'superseded', so we deliberately skip
											// both the setStatus('error') and the WS
											// broadcast here. Local fanOut still runs
											// so any live SSE subscriber tears down
											// cleanly. Mirrors the opencode path,
											// which gates its push() on
											// `cancelledByCaller` (doctrine #13:
											// agent-path parity).
											if (job.abortController.signal.aborted) {
												debug(
													"walkthrough-jobs",
													"suppressing error broadcast — abort initiated locally:",
													event.data.message,
												);
												fanOut(job, event);
												return;
											}
											await Effect.runPromise(
												setStatus(
													job.walkthroughId,
													"error",
												),
											);
											await Effect.runPromise(
												hub
													.broadcast({
														type: "walkthrough:error",
														data: {
															prId: ctx.pr.id,
															message:
																event.data.message,
														},
													})
													.pipe(
														Effect.timeout("5 seconds"),
														Effect.catchAll(
															() => Effect.void,
														),
													),
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
									if (
										capturedOpencodeSessionId !== undefined
									) {
										await Effect.runPromise(
											provideDb(
												walkthroughService.setOpencodeSessionId(
													job.walkthroughId,
													capturedOpencodeSessionId,
												),
											).pipe(
												Effect.catchAll(() => Effect.void),
											),
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
										autoContinuations >=
											MAX_AUTO_CONTINUATIONS
											? "max continuations reached"
											: "aborted",
									);
									// Mark error if either:
									//   (a) we never reached Phase D, OR
									//   (b) we reached Phase D but the
									//       comment-pairing invariant (doctrine
									//       #12) is still violated.
									// Otherwise the row would stay in
									// `generating` forever (case a) or land in
									// `complete` despite missing inline
									// comments (case b).
									const finalState = await Effect.runPromise(
										provideDb(
											walkthroughService.getPartial(
												ctx.pr.id,
												ctx.prHeadSha,
											),
										).pipe(
											Effect.catchAll(() =>
												Effect.succeed(null),
											),
										),
									);
									const phaseD =
										finalState?.lastCompletedPhase === "D";
									const missingCommentsAtExhaustion = phaseD
										? findIssuesMissingInlineComment(
												db,
												job.walkthroughId,
											)
										: [];
									if (
										!phaseD ||
										missingCommentsAtExhaustion.length > 0
									) {
										if (
											phaseD &&
											missingCommentsAtExhaustion.length >
												0
										) {
											debug(
												"walkthrough-jobs",
												`exhausted auto-continuations with ${missingCommentsAtExhaustion.length} warning/critical issue(s) still missing inline comment(s) — marking error`,
											);
										}
										await Effect.runPromise(
											setStatus(
												job.walkthroughId,
												"error",
											),
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

								const partialForContinuation =
									await Effect.runPromise(
										provideDb(
											walkthroughService.getPartial(
												ctx.pr.id,
												ctx.prHeadSha,
											),
										).pipe(
											Effect.catchAll(() =>
												Effect.succeed(null),
											),
										),
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
									existingBlocks:
										partialForContinuation.blocks,
									existingIssueCount:
										partialForContinuation.issues.length,
									existingRatedAxes:
										partialForContinuation.ratings.map(
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
									ai.streamWalkthrough(
										buildStreamParams(continuationCtx),
									),
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
							logError(
								"walkthrough-jobs",
								"job failed:",
								Cause.pretty(cause),
							);
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
								? (failureOpt.value as { cause?: unknown })
										.cause instanceof Error
									? (
											(failureOpt.value as {
												cause: Error;
											}).cause.message
										)
									: String(
											(failureOpt.value as {
												cause?: unknown;
											}).cause ?? failureOpt.value,
										)
								: "Walkthrough generation failed";
						const code = cancelledByUser
							? "Cancelled"
							: "AiGenerationError";

						yield* setStatus(job.walkthroughId, "error").pipe(
							Effect.catchAll(() => Effect.void),
						);

						// Bound the broadcast: a wedged WS subscriber could otherwise
						// hold the failure handler open, which (because Effect.ensuring
						// runs *after* the wrapped effect completes) keeps the global
						// MAX_CONCURRENT_JOBS semaphore permit, the registry entry,
						// and the session token map entry all live. Across multiple
						// failing jobs that adds up to a permanently exhausted job
						// queue. 5s is generous for a healthy hub; on timeout we
						// swallow alongside the existing catch-all.
						yield* hub
							.broadcast({
								type: "walkthrough:error",
								data: { prId: job.prId, message },
							})
							.pipe(
								Effect.timeout("5 seconds"),
								Effect.catchAll(() => Effect.void),
							);
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
				// Resume fast-path: if the caller passed a specific walkthroughId
				// (resumePending / explicit resume) and the registry already holds
				// that exact job, short-circuit without acquiring the mutex or
				// touching GitHub. This is the common case for SSE re-subscribe
				// and avoids blocking on any other in-flight startJob for the
				// same PR.
				if (params.walkthroughId !== undefined) {
					const cached = yield* findActiveByPr(params.prId);
					if (
						cached !== null &&
						cached.walkthroughId === params.walkthroughId
					) {
						return { walkthroughId: cached.walkthroughId };
					}
				}

				// Per-PR serialization (see `startJobMutexes` rationale). The
				// remainder of startJob — findActiveByPr, resolveWithDiff,
				// SHA-aware dedup, createPartial, launchJob — runs under the
				// mutex so the check-and-launch is atomic per PR and concurrent
				// callers can't both reach `launchJob` and fork duplicate fibers.
				const mutex = yield* acquireStartJobMutex(params.prId);
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
					prContextService.resolveWithDiff(
						params.prId,
						params.userId,
					),
				);
				const { pr, repo, token, meta, files } = resolved;

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

				const cloneStatus = yield* repoCloneService.getCloneStatus(
					repo.id,
				);
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
				const reviewSessionId =
					partial?.reviewSessionId ?? reviewSession.id;

				const settings = yield* provideDb(settingsService.getSettings());
				const agent = resolveAgent(settings);
				const freshModelUsed =
					settings.aiModel ??
					(agent === "opencode" ? "opencode" : "claude-sonnet-4-20250514");
				const modelUsed =
					params.trigger === "resume"
						? freshModelUsed
						: (partial?.modelUsed && partial.modelUsed !== "unknown"
							? partial.modelUsed
							: freshModelUsed);

				// Idempotent row creation (upsert on the new unique index).
				// This is the sole "make a walkthrough row exist" call in the
				// codebase — MCP tool handlers never insert, they only update.
				const walkthroughId = yield* provideDb(
					walkthroughService.createPartial({
						...(partial?.id ?? params.walkthroughId
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
								message:
									err instanceof Error
										? err.message
										: String(err),
							}),
					),
				);

				// On user-triggered resume, sync the stored modelUsed to current settings
				// so the DB reflects which agent is actually running this continuation.
				if (
					params.trigger === "resume" &&
					partial !== null &&
					partial.modelUsed !== modelUsed
				) {
					yield* provideDb(
						walkthroughService.updateModelUsed(partial.id, modelUsed),
					);
				}

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
										err instanceof Error
											? err.message
											: String(err),
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
						job.abortController.abort(
							new Error("Walkthrough cancelled"),
						);
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
				yield* setStatus(walkthroughId, 'generating');
				yield* provideDb(
					walkthroughService.resetResumeAttempts(walkthroughId),
				);
			});

		const resumePending = (): Effect.Effect<void> =>
			Effect.gen(function* () {
				const rows = yield* provideDb(
					walkthroughService.listGenerating(),
				);
				debug(
					"walkthrough-jobs",
					"resumePending: found",
					rows.length,
					"generating rows",
				);

				// No worktree GC on resume: the unified per-PR worktree at
				// `worktrees/pr-{prNumber}` is shared across walkthroughs and
				// chat sessions, so it's never orphaned by a walkthrough fiber
				// dying. The next `acquirePrWorktree` call simply refreshes
				// the existing dir to the desired SHA in place.

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
							.pipe(
								Effect.timeout("5 seconds"),
								Effect.catchAll(() => Effect.void),
							);
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
				for (const job of map.values()) {
					if (job.prId !== prId) continue;
					if (
						exceptHeadSha !== undefined &&
						job.prHeadSha === exceptHeadSha
					) {
						continue;
					}
					yield* cancel(job.walkthroughId);
				}
				yield* provideDb(
					walkthroughService.supersedeAllForPr(prId, exceptHeadSha),
				);
			});

		const emitEvent = (
			walkthroughId: string,
			event: WalkthroughStreamEvent,
		) =>
			Effect.gen(function* () {
				const map = yield* Ref.get(registry);
				const job = map.get(walkthroughId);
				if (!job) return;
				fanOut(job, event);
				// Fire the activity notifier so the opencode provider's stream guard
				// resets its inactivity timer. This runs even when the SSE subscription
				// from the daemon doesn't surface the tool-call event.
				const notifiers = yield* Ref.get(activityNotifiers);
				const notify = notifiers.get(walkthroughId);
				if (notify) {
					// Push a phase heartbeat to reset the stream guard's inactivity timer.
					// Content events already reach the frontend via fanOut — don't re-emit them.
					try {
						notify({ type: 'phase', data: { phase: 'exploring', message: 'Processing...' } });
					} catch { /* notifier threw — ignore */ }
				}
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
			reviveFromError,
			resumePending,
			supersedeWalkthrough,
			supersedeForPr,
			emitEvent,
			issueSessionToken,
			resolveSessionToken,
			clearSessionToken,
			registerActivityNotifier,
			unregisterActivityNotifier,
		};
	}),
);
