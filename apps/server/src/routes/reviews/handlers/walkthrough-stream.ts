import { Context, Duration, Effect } from 'effect';
import { AppRuntime } from '../../../runtime';
import { debug, logError } from '../../../logger';
import { AiService, type ContinuationContext, resolveAgent } from '../../../services/Ai';
import { PrContextService } from '../../../services/PrContext';
import { RepoCloneService } from '../../../services/RepoClone';
import { ReviewService } from '../../../services/Review';
import { SettingsService } from '../../../services/Settings';
import { WalkthroughService } from '../../../services/Walkthrough';
import { WebSocketHub } from '../../../services/WebSocketHub';
import { POLL_CLONE_MAX_ATTEMPTS, POLL_CLONE_INTERVAL_SECONDS } from '../../../constants';
import { unwrapEffectError } from '../../middleware';
import { createSseStream, sseHeaders, type SseWriter } from '../sse';
import type { RiskLevel, WalkthroughStreamEvent, Repository } from '@revv/shared';

/**
 * Ensure a git clone exists and a PR worktree is set up.
 * Triggers a clone if needed and waits until it's ready (up to 10 minutes).
 */
function ensureWorktree(
	cloneSvc: Context.Tag.Service<typeof RepoCloneService>,
	repo: Repository,
	prNumber: number,
	ghToken: string,
) {
	return Effect.gen(function* () {
		const { status } = yield* cloneSvc.getCloneStatus(repo.id);

		if (status === 'pending' || status === 'error') {
			yield* cloneSvc.cloneRepo(repo, ghToken);
		} else if (status === 'cloning') {
			yield* pollCloneReady(cloneSvc, repo);
		}
		// status === 'ready' falls through — no action needed

		return yield* cloneSvc.ensurePrWorktree(repo.id, prNumber, ghToken);
	});
}

function pollCloneReady(
	cloneSvc: { readonly getCloneStatus: (repoId: string) => Effect.Effect<{ status: string }> },
	repo: Repository,
) {
	return Effect.gen(function* () {
		for (let i = 0; i < POLL_CLONE_MAX_ATTEMPTS; i++) {
			const { status } = yield* cloneSvc.getCloneStatus(repo.id);
			if (status === 'ready') return;
			if (status === 'error') {
				return yield* Effect.fail(new Error(`Clone failed for ${repo.fullName}`));
			}
			yield* Effect.sleep(Duration.seconds(POLL_CLONE_INTERVAL_SECONDS));
		}
		return yield* Effect.fail(new Error(`Clone timed out for ${repo.fullName}`));
	});
}

interface GeneratorBundle {
	generator: AsyncGenerator<WalkthroughStreamEvent>;
	reviewSessionId: string;
	prId: string;
	headSha: string;
	modelUsed: string;
	existingWalkthroughId: string | undefined;
	resumeFromBlockCount: number;
}

/**
 * Decide whether to replay a cached walkthrough, resume a partial one, or
 * start a fresh AI stream. Returns an async generator the caller iterates
 * to produce client-facing SSE events.
 */
const buildGenerator = (
	prId: string,
	headSha: string,
	pr: {
		id: string;
		title: string;
		body: string | null;
		sourceBranch: string;
		targetBranch: string;
		url: string;
	},
	files: readonly unknown[],
	worktreePath: string,
) =>
	Effect.gen(function* () {
		const ai = yield* AiService;
		const walkthroughService = yield* WalkthroughService;
		const reviewService = yield* ReviewService;

		// ── Partial (in-progress / errored) ─────────────────────────────────
		const partial = yield* walkthroughService.getPartial(prId, headSha);
		if (partial) {
			const ageMs = Date.now() - new Date(partial.generatedAt).getTime();
			const fiveMinutesMs = 5 * 60 * 1000;
			if (ageMs < fiveMinutesMs && partial.status !== 'error') {
				// Generation is already running in the background — replay existing
				// data and tell the client to listen on WS for completion.
			const replayGen = (async function* (): AsyncGenerator<WalkthroughStreamEvent> {
				yield { type: 'summary' as const, data: { summary: partial.summary, riskLevel: partial.riskLevel } };
				for (const block of partial.blocks) yield { type: 'block' as const, data: block };
				for (const issue of partial.issues) yield { type: 'issue' as const, data: issue };
				if (partial.ratings.length > 0) yield { type: 'phase' as const, data: { phase: 'rating' as const, message: 'Scoring the PR across 9 axes...' } };
				for (const rating of partial.ratings) yield { type: 'rating' as const, data: rating };
				yield { type: 'in-progress' as const, data: { walkthroughId: partial.id } };
				})();
				return {
					generator: replayGen,
					reviewSessionId: partial.reviewSessionId,
					prId,
					headSha,
					modelUsed: partial.modelUsed,
					existingWalkthroughId: undefined,
					resumeFromBlockCount: 0,
				};
			}

			// Stale or errored partial — resume from where it left off.
			const settingsService = yield* SettingsService;
			const settings = yield* settingsService.getSettings();
			const continuation: ContinuationContext = {
				walkthroughId: partial.id,
				existingBlocks: partial.blocks,
				existingIssueCount: partial.issues.length,
				existingRatedAxes: partial.ratings.map((r) => r.axis),
				...(partial.opencodeSessionId !== null && partial.opencodeSessionId !== undefined
					? { opencodeSessionId: partial.opencodeSessionId }
					: {}),
			};
			const reviewSession = yield* reviewService.getOrCreateActiveSession(prId);
			let capturedSessionId: string | undefined;
			const continuationGenerator = yield* ai.streamWalkthrough({
				pr: {
					title: pr.title,
					body: pr.body,
					sourceBranch: pr.sourceBranch,
					targetBranch: pr.targetBranch,
					url: pr.url,
				},
				files: files as never,
				worktreePath,
				continuation,
				onSessionId: (id) => {
					capturedSessionId = id;
				},
			});
			const existingBlocks = [...partial.blocks];
			const existingIssues = [...partial.issues];
			const existingRatings = [...partial.ratings];
			const partialId = partial.id;
		const replayAndContinueGen = (async function* (): AsyncGenerator<WalkthroughStreamEvent> {
			yield { type: 'summary' as const, data: { summary: partial.summary, riskLevel: partial.riskLevel } };
			for (const block of existingBlocks) yield { type: 'block' as const, data: block };
			for (const issue of existingIssues) yield { type: 'issue' as const, data: issue };
			if (existingRatings.length > 0) yield { type: 'phase' as const, data: { phase: 'rating' as const, message: 'Scoring the PR across 9 axes...' } };
			for (const rating of existingRatings) yield { type: 'rating' as const, data: rating };
				yield* continuationGenerator;
				// Persist the new opencode session ID after generation completes
				if (capturedSessionId !== undefined) {
					const sid = capturedSessionId;
					AppRuntime.runPromise(
						Effect.gen(function* () {
							const ws = yield* WalkthroughService;
							yield* ws.setOpencodeSessionId(partialId, sid);
						}),
					).catch(() => {
						/* best-effort */
					});
				}
			})();
			const modelUsed =
				partial.modelUsed !== 'unknown'
					? partial.modelUsed
					: (settings.aiModel ??
						(resolveAgent(settings) === 'opencode' ? 'opencode' : 'claude-sonnet-4-20250514'));
			return {
				generator: replayAndContinueGen,
				reviewSessionId: reviewSession.id,
				prId,
				headSha,
				modelUsed,
				existingWalkthroughId: partial.id,
				resumeFromBlockCount: existingBlocks.length,
			};
		}

		// ── Complete cache hit ──────────────────────────────────────────────
		const cached = yield* walkthroughService.getCached(prId, headSha);
		if (cached) {
			const replayGen = (async function* (): AsyncGenerator<WalkthroughStreamEvent> {
				yield { type: 'summary' as const, data: { summary: cached.summary, riskLevel: cached.riskLevel } };
				for (const block of cached.blocks) yield { type: 'block' as const, data: block };
				for (const issue of cached.issues) yield { type: 'issue' as const, data: issue };
				for (const rating of cached.ratings) yield { type: 'rating' as const, data: rating };
				yield { type: 'done' as const, data: { walkthroughId: cached.id, tokenUsage: cached.tokenUsage } };
			})();
			return {
				generator: replayGen,
				reviewSessionId: cached.reviewSessionId,
				prId,
				headSha,
				modelUsed: cached.modelUsed,
				existingWalkthroughId: cached.id,  // prevent duplicate walkthrough creation on replay
				resumeFromBlockCount: cached.blocks.length,
			};
		}

		// ── Fresh AI stream ─────────────────────────────────────────────────
		const reviewSession = yield* reviewService.getOrCreateActiveSession(prId);
		const settingsSvc = yield* SettingsService;
		const freshSettings = yield* settingsSvc.getSettings();
		const freshAgent = resolveAgent(freshSettings);
		const freshModelUsed =
			freshSettings.aiModel ??
			(freshAgent === 'opencode' ? 'opencode' : 'claude-sonnet-4-20250514');

		// Consume any carried-over issues from the preceding regenerate call.
		const carriedOverIssues = yield* walkthroughService.consumePendingCarriedOver(prId);

		const generator = yield* ai.streamWalkthrough({
			pr: {
				title: pr.title,
				body: pr.body,
				sourceBranch: pr.sourceBranch,
				targetBranch: pr.targetBranch,
				url: pr.url,
			},
			files: files as never,
			worktreePath,
			...(carriedOverIssues.length > 0 ? { carriedOverIssues } : {}),
		});
		return {
			generator,
			reviewSessionId: reviewSession.id,
			prId,
			headSha,
			modelUsed: freshModelUsed,
			existingWalkthroughId: undefined,
			resumeFromBlockCount: 0,
		};
	});

/**
 * Persist + stream a single walkthrough event. Returns void — the writer's
 * cancel state is the signal for background-vs-streaming.
 */
async function handleEvent(
	event: WalkthroughStreamEvent,
	state: {
		readonly prId: string;
		readonly reviewSessionId: string;
		readonly headSha: string;
		readonly modelUsed: string;
		readonly resumeFromBlockCount: number;
		walkthroughId: string | null;
		collectedSummary: string;
		collectedRiskLevel: RiskLevel;
		issueOrderCounter: number;
	},
	writer: SseWriter,
): Promise<void> {
	debug('walkthrough-sse', 'got event:', event.type);

	if (event.type === 'summary') {
		state.collectedSummary = event.data.summary;
		state.collectedRiskLevel = event.data.riskLevel;
		if (state.walkthroughId === null) {
			state.walkthroughId = await AppRuntime.runPromise(
				Effect.gen(function* () {
					const ws = yield* WalkthroughService;
					return yield* ws.createPartial({
						reviewSessionId: state.reviewSessionId,
						prId: state.prId,
						summary: state.collectedSummary,
						riskLevel: state.collectedRiskLevel,
						modelUsed: state.modelUsed,
						prHeadSha: state.headSha,
					});
				}),
			);
		}
		// Resume path: walkthroughId already set, skip createPartial
	} else if (event.type === 'block' && state.walkthroughId !== null) {
		// Skip persisting replayed blocks (already in DB).
		const isReplayedBlock = event.data.order < state.resumeFromBlockCount;
		if (!isReplayedBlock) {
			const capturedId = state.walkthroughId;
			await AppRuntime.runPromise(
				Effect.gen(function* () {
					const ws = yield* WalkthroughService;
					yield* ws.addBlock(capturedId, event.data);
				}),
			).catch((err) => {
				logError('walkthrough-sse', 'Failed to persist block:', err);
			});
		}
	} else if (event.type === 'issue' && state.walkthroughId !== null) {
		const capturedId = state.walkthroughId;
		const issueOrder = state.issueOrderCounter++;
		await AppRuntime.runPromise(
			Effect.gen(function* () {
				const ws = yield* WalkthroughService;
				yield* ws.addIssue(capturedId, event.data, issueOrder);
			}),
		).catch((err) => {
			logError('walkthrough-sse', 'Failed to persist issue:', err);
		});
	} else if (event.type === 'rating' && state.walkthroughId !== null) {
		const capturedId = state.walkthroughId;
		await AppRuntime.runPromise(
			Effect.gen(function* () {
				const ws = yield* WalkthroughService;
				yield* ws.addRating(capturedId, event.data);
			}),
		).catch((err) => {
			logError('walkthrough-sse', 'Failed to persist rating:', err);
		});
	} else if (event.type === 'done' && state.walkthroughId !== null) {
		const capturedId = state.walkthroughId;
		await AppRuntime.runPromise(
			Effect.gen(function* () {
				const ws = yield* WalkthroughService;
				yield* ws.markComplete(capturedId, event.data.tokenUsage);
			}),
		).catch((err) => {
			logError('walkthrough-sse', 'Failed to mark walkthrough complete:', err);
		});
		// Broadcast completion via WebSocket so background listeners hear it.
		await AppRuntime.runPromise(
			Effect.gen(function* () {
				const hub = yield* WebSocketHub;
				yield* hub.broadcast({
					type: 'walkthrough:complete',
					data: { prId: state.prId, walkthroughId: capturedId },
				});
			}),
		).catch(() => {
			/* best-effort */
		});
		// Overwrite empty walkthroughId in done event with real ID before sending
		writer.send({ ...event, data: { ...event.data, walkthroughId: capturedId } });
		return;
	}

	// Stream to SSE only if client is still connected.
	if (!writer.isCancelled()) {
		const sent = writer.send(event);
		if (!sent) {
			debug('walkthrough-sse', 'client disconnected, continuing generation in background');
		}
	}
}

/**
 * GET /api/reviews/:id/walkthrough — SSE streaming walkthrough.
 *
 * Returns the Response immediately with an SSE stream and runs setup +
 * generation in the background. This way the client gets the connection right
 * away instead of waiting 10–30s for git clone + worktree setup.
 */
export function walkthroughStreamHandler(ctx: {
	params: { id: string };
	session: { user: { id: string } };
}): Response {
	const { stream, writer, stopHeartbeat } = createSseStream();

	// Fire setup + generation in the background.
	void (async () => {
		// walkthroughId is declared here so the catch block can call markError.
		let walkthroughId: string | null = null;

		try {
			// Immediate phase so the client UI unblocks instantly.
			if (!writer.sendPhase('connecting', 'Connecting...')) return;

			// ── Step 1: Resolve PR context (DB + GitHub API) ──────────────
			if (!writer.sendPhase('connecting', 'Fetching PR details...')) return;

			const { pr, repo, token: ghToken, meta, files } = await AppRuntime.runPromise(
				Effect.flatMap(PrContextService, (s) =>
					s.resolveWithDiff(ctx.params.id, ctx.session.user.id),
				),
			);

			// ── Step 2: Ensure git worktree (clone/checkout) ──────────────
			if (!writer.sendPhase('connecting', 'Preparing repository...')) return;

			const worktreePath = await AppRuntime.runPromise(
				Effect.gen(function* () {
					const cloneSvc = yield* RepoCloneService;
					return yield* ensureWorktree(cloneSvc, repo, pr.externalId, ghToken);
				}).pipe(
					Effect.timeout(Duration.minutes(3)),
					Effect.catchTag('TimeoutException', () =>
						Effect.fail(
							new Error(
								'Repository setup timed out after 3 minutes. The git clone or worktree checkout took too long.',
							),
						),
					),
				),
			);

			// ── Step 3: Build generator (cache / partial / fresh) ────────
			if (!writer.sendPhase('connecting', 'Starting AI analysis...')) return;

			const bundle = await AppRuntime.runPromise(
				buildGenerator(pr.id, meta.headSha, pr, files, worktreePath).pipe(
					Effect.timeout(Duration.minutes(2)),
					Effect.catchTag('TimeoutException', () =>
						Effect.fail(new Error('AI setup timed out after 2 minutes.')),
					),
				),
			);

			// ── Step 4: Iterate generator, persist, stream ───────────────
			if (!writer.sendPhase('connecting', 'Waiting for AI response...')) return;

			walkthroughId = bundle.existingWalkthroughId ?? null;
			const state = {
				prId: bundle.prId,
				reviewSessionId: bundle.reviewSessionId,
				headSha: bundle.headSha,
				modelUsed: bundle.modelUsed,
				resumeFromBlockCount: bundle.resumeFromBlockCount,
				walkthroughId,
				collectedSummary: '',
				collectedRiskLevel: 'low' as RiskLevel,
				issueOrderCounter: 0,
			};

			for await (const event of bundle.generator) {
				await handleEvent(event, state, writer);
				// Keep local walkthroughId in sync for the catch block below.
				walkthroughId = state.walkthroughId;
			}

			writer.sendDone();
		} catch (err) {
			logError('walkthrough-sse', 'Walkthrough error:', err);
			if (walkthroughId !== null) {
				const capturedId = walkthroughId;
				AppRuntime.runPromise(
					Effect.gen(function* () {
						const ws = yield* WalkthroughService;
						yield* ws.markError(capturedId);
					}),
				).catch(() => {
					/* best-effort */
				});
			}
			const e = unwrapEffectError(err);
			const message = e instanceof Error ? e.message : 'Walkthrough generation failed';
			// Broadcast error via WebSocket so background listeners are notified.
			AppRuntime.runPromise(
				Effect.gen(function* () {
					const hub = yield* WebSocketHub;
					yield* hub.broadcast({
						type: 'walkthrough:error',
						data: { prId: ctx.params.id, message },
					});
				}),
			).catch(() => {
				/* best-effort */
			});
			writer.send({ type: 'error', data: { code: 'GENERATION_ERROR', message } });
			writer.close();
		} finally {
			stopHeartbeat();
		}
	})();

	return new Response(stream, { headers: sseHeaders });
}
