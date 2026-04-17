import { Elysia, t } from 'elysia';
import { Context, Duration, Effect } from 'effect';
import { AppRuntime } from '../runtime';
import { debug, logError } from '../logger';
import { AiService, type ContinuationContext, resolveAgent } from '../services/Ai';
import { GitHubService } from '../services/GitHub';
import { getOrFetchDiffFiles } from '../services/DiffCache';
import { PullRequestService } from '../services/PullRequest';
import { RepoCloneService } from '../services/RepoClone';
import { RepositoryService } from '../services/Repository';
import { ReviewService } from '../services/Review';
import { SettingsService } from '../services/Settings';
import { SyncService } from '../services/Sync';
import { TokenProvider } from '../services/TokenProvider';
import { WalkthroughService } from '../services/Walkthrough';
import { WebSocketHub } from '../services/WebSocketHub';
import { POLL_CLONE_MAX_ATTEMPTS, POLL_CLONE_INTERVAL_SECONDS } from '../constants';
import { withAuth, handleAppError, unwrapEffectError, jsonResponse, mapErrorToSSEResponse } from './middleware';
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

export const reviewRoutes = new Elysia({ prefix: '/api/reviews' })
	.use(withAuth)
	// GET /api/reviews/active/:prId — get or create the active session, fully hydrated
	.get('/active/:prId', async (ctx) => {
		try {
			return await AppRuntime.runPromise(
				Effect.gen(function* () {
					const reviewService = yield* ReviewService;

					const reviewSession = yield* reviewService.getOrCreateActiveSession(
						ctx.params.prId,
					);

					const threads = yield* reviewService.getThreadsForSession(reviewSession.id);

					// Load messages for all threads
					const messages: Record<string, import('@revv/shared').ThreadMessage[]> = {};
					for (const thread of threads) {
						messages[thread.id] = yield* reviewService.getMessages(thread.id);
					}

					const hunkDecisions = yield* reviewService.getHunkDecisions(reviewSession.id);

					return { session: reviewSession, threads, messages, hunkDecisions };
				}),
			);
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

	// POST /api/reviews — create a new session
	.post(
		'/',
		async (ctx) => {
			try {
				return await AppRuntime.runPromise(
					Effect.flatMap(ReviewService, (s) =>
						s.getOrCreateActiveSession(ctx.body.pullRequestId),
					),
				);
			} catch (e) {
				return handleAppError(e, ctx);
			}
		},
		{ body: t.Object({ pullRequestId: t.String() }) },
	)

	// PATCH /api/reviews/:id — complete or abandon a session
	.patch(
		'/:id',
		async (ctx) => {
			try {
				await AppRuntime.runPromise(
					Effect.flatMap(ReviewService, (s) =>
						s.completeSession(ctx.params.id, ctx.body.status),
					),
				);
				return { success: true };
			} catch (e) {
				return handleAppError(e, ctx);
			}
		},
		{ body: t.Object({ status: t.Union([t.Literal('completed'), t.Literal('abandoned')]) }) },
	)

	// GET /api/reviews/:id/threads — list threads for a session
	.get(
		'/:id/threads',
		async (ctx) => {
			try {
				return await AppRuntime.runPromise(
					Effect.gen(function* () {
						const reviewService = yield* ReviewService;
						if (ctx.query.filePath) {
							return yield* reviewService.getThreadsForFile(
								ctx.params.id,
								ctx.query.filePath,
							);
						}
						return yield* reviewService.getThreadsForSession(ctx.params.id);
					}),
				);
			} catch (e) {
				return handleAppError(e, ctx);
			}
		},
		{ query: t.Object({ filePath: t.Optional(t.String()) }) },
	)

	// POST /api/reviews/:id/threads — create a thread with initial message
	.post(
		'/:id/threads',
		async (ctx) => {
			try {
				const result = await AppRuntime.runPromise(
					Effect.gen(function* () {
						const reviewService = yield* ReviewService;
						const hub = yield* WebSocketHub;
						const sync = yield* SyncService;

						const thread = yield* reviewService.createThread(ctx.params.id, {
							filePath: ctx.body.filePath,
							startLine: ctx.body.startLine,
							endLine: ctx.body.endLine,
							diffSide: ctx.body.diffSide,
						});

						const message = yield* reviewService.addMessage(thread.id, {
							authorRole: ctx.body.message.authorRole,
							authorName: ctx.body.message.authorName,
							body: ctx.body.message.body,
							messageType: ctx.body.message.messageType,
							...(ctx.body.message.codeSuggestion !== undefined
								? { codeSuggestion: ctx.body.message.codeSuggestion }
								: {}),
						});

						// Auto-transition based on author role.
						const transitioned = yield* reviewService
							.transitionStatus(thread.id, ctx.body.message.authorRole)
							.pipe(Effect.catchAll(() => Effect.succeed(null)));

						yield* hub.broadcast({
							type: 'thread:created',
							data: {
								sessionId: ctx.params.id,
								thread: transitioned ?? thread,
								message,
							},
						});

						// Fire-and-forget auto-push to GitHub.
						yield* sync.pushThread(thread.id).pipe(Effect.catchAll(() => Effect.void));

						return { thread: transitioned ?? thread, message };
					}),
				);

				ctx.set.status = 201;
				return result;
			} catch (e) {
				return handleAppError(e, ctx);
			}
		},
		{
			body: t.Object({
				filePath: t.String(),
				startLine: t.Number(),
				endLine: t.Number(),
				diffSide: t.Union([t.Literal('old'), t.Literal('new')]),
				message: t.Object({
					authorRole: t.Union([
						t.Literal('reviewer'),
						t.Literal('coder'),
						t.Literal('ai_agent'),
					]),
					authorName: t.String(),
					body: t.String(),
					messageType: t.Union([
						t.Literal('comment'),
						t.Literal('reply'),
						t.Literal('suggestion'),
						t.Literal('resolution'),
					]),
					codeSuggestion: t.Optional(t.String()),
				}),
			}),
		},
	)

	// GET /api/reviews/:id/hunks — list hunk decisions
	.get('/:id/hunks', async (ctx) => {
		try {
			return await AppRuntime.runPromise(
				Effect.flatMap(ReviewService, (s) => s.getHunkDecisions(ctx.params.id)),
			);
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

	// PUT /api/reviews/:id/hunks — set a hunk decision (upsert)
	.put(
		'/:id/hunks',
		async (ctx) => {
			try {
				await AppRuntime.runPromise(
					Effect.flatMap(ReviewService, (s) =>
						s.setHunkDecision(
							ctx.params.id,
							ctx.body.filePath,
							ctx.body.hunkIndex,
							ctx.body.decision,
						),
					),
				);

				return { success: true };
			} catch (e) {
				return handleAppError(e, ctx);
			}
		},
		{
			body: t.Object({
				filePath: t.String(),
				hunkIndex: t.Number(),
				decision: t.Union([t.Literal('accepted'), t.Literal('rejected')]),
			}),
		},
	)

	// DELETE /api/reviews/:id/hunks/:filePath/:hunkIndex — clear a hunk decision
	.delete('/:id/hunks/:filePath/:hunkIndex', async (ctx) => {
		try {
			await AppRuntime.runPromise(
				Effect.flatMap(ReviewService, (s) =>
					s.clearHunkDecision(
						ctx.params.id,
						decodeURIComponent(ctx.params.filePath),
						Number(ctx.params.hunkIndex),
					),
				),
			);

			return { success: true };
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

	// GET /api/reviews/:id/walkthrough — SSE streaming walkthrough
	.get('/:id/walkthrough', (ctx) => {
		// Use ReadableStream with a synchronous start() to capture the controller.
		// controller.enqueue() flushes immediately in Bun, unlike TransformStream writes.
		const encoder = new TextEncoder();
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		let cancelled = false;
		const sseStream = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
			cancel() {
				cancelled = true;
			},
		});

		// Run setup + generation entirely in the background so the Response is returned
		// immediately — the client gets the SSE connection right away instead of waiting
		// for git clone / worktree checkout (which can take 10-30s).
		(async () => {
			// Send an immediate connecting event so the client UI unblocks without waiting
			// for git clone / worktree setup to complete.
			try {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'phase', data: { phase: 'connecting', message: 'Connecting...' } })}\n\n`));
			} catch { return; }

			// Send SSE keepalive comments every 15s to prevent proxy/client timeouts.
			// Started before setup so the connection stays alive during git clone.
			const heartbeat = setInterval(() => {
				try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { /* controller closed */ }
			}, 15_000);

			// walkthroughId is declared here so the catch block can call markError
			let walkthroughId: string | null = null;

			try {
				// ── Step 1: Resolve PR context (DB + GitHub API) ──────────────
				try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'phase', data: { phase: 'connecting', message: 'Fetching PR details...' } })}\n\n`)); } catch { return; }

				const { pr, repo, ghToken, meta, files } = await AppRuntime.runPromise(
					Effect.gen(function* () {
						const prService = yield* PullRequestService;
						const repoService = yield* RepositoryService;
						const tokenProvider = yield* TokenProvider;
						const github = yield* GitHubService;

						const pr = yield* prService.getPr(ctx.params.id);
						const repo = yield* repoService.getRepoById(pr.repositoryId);
						const ghToken = yield* tokenProvider.getGitHubToken(ctx.session.user.id);
						const meta = yield* github.getPrMeta(repo.fullName, pr.externalId, ghToken);
						const cachedFiles = yield* getOrFetchDiffFiles(pr.id, repo.fullName, pr.externalId, ghToken);
						const files = cachedFiles.map((f) => ({
							filename: f.path,
							previousFilename: f.oldPath,
							status: f.status,
							additions: f.additions,
							deletions: f.deletions,
							patch: f.patch,
						}));
						return { pr, repo, ghToken, meta, files };
					}),
				);

				// ── Step 2: Ensure git worktree (clone/checkout) ──────────────
				try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'phase', data: { phase: 'connecting', message: 'Preparing repository...' } })}\n\n`)); } catch { return; }

				const worktreePath = await AppRuntime.runPromise(
					Effect.gen(function* () {
						const cloneSvc = yield* RepoCloneService;
						return yield* ensureWorktree(cloneSvc, repo, pr.externalId, ghToken);
					}).pipe(
						Effect.timeout(Duration.minutes(3)),
						Effect.catchTag('TimeoutException', () => Effect.fail(new Error('Repository setup timed out after 3 minutes. The git clone or worktree checkout took too long.'))),
					),
				);

				// ── Step 3: Check cache / partial, build generator ────────────
				try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'phase', data: { phase: 'connecting', message: 'Starting AI analysis...' } })}\n\n`)); } catch { return; }

				const { generator, reviewSessionId, prId, headSha, modelUsed, existingWalkthroughId, resumeFromBlockCount } = await AppRuntime.runPromise(
					Effect.gen(function* () {
						const ai = yield* AiService;
						const walkthroughService = yield* WalkthroughService;
						const reviewService = yield* ReviewService;

						// ── Check partial (in-progress / errored) ───────────────────
						const partial = yield* walkthroughService.getPartial(pr.id, meta.headSha);
						if (partial) {
							const ageMs = Date.now() - new Date(partial.generatedAt).getTime();
							const fiveMinutesMs = 5 * 60 * 1000;
							if (ageMs < fiveMinutesMs && partial.status !== 'error') {
								// Generation is running in the background — replay existing
								// data and tell the client to listen on WS for completion.
								const replayGen = (async function* (): AsyncGenerator<WalkthroughStreamEvent> {
									yield { type: 'summary' as const, data: { summary: partial.summary, riskLevel: partial.riskLevel } };
									for (const block of partial.blocks) {
										yield { type: 'block' as const, data: block };
									}
									for (const issue of partial.issues) {
										yield { type: 'issue' as const, data: issue };
									}
									yield { type: 'in-progress' as const, data: { walkthroughId: partial.id } };
								})();
								return {
									generator: replayGen,
									reviewSessionId: partial.reviewSessionId,
									prId: pr.id,
									headSha: meta.headSha,
									modelUsed: partial.modelUsed,
									existingWalkthroughId: undefined as string | undefined,
									resumeFromBlockCount: 0,
								};
							}
							// Only the MCP (claude) provider honors `continuation` by
							// offsetting its block counter. The CLI (opencode) provider
							// regenerates from scratch starting at block-0, which collides
							// with the replayed block IDs and breaks the keyed each on the
							// client. For CLI, drop the stale partial and fall through to a
							// fresh generation.
							const settingsService = yield* SettingsService;
							const settings = yield* settingsService.getSettings();
							if (resolveAgent(settings) === 'claude') {
								const continuation: ContinuationContext = {
									walkthroughId: partial.id,
									existingBlocks: partial.blocks,
									existingIssueCount: partial.issues.length,
								};
								const reviewSession = yield* reviewService.getOrCreateActiveSession(pr.id);
								const continuationGenerator = yield* ai.streamWalkthrough({
									pr: {
										title: pr.title,
										body: pr.body,
										sourceBranch: pr.sourceBranch,
										targetBranch: pr.targetBranch,
										url: pr.url,
									},
									files,
									worktreePath,
									continuation,
								});
								const existingBlocks = [...partial.blocks];
								const replayAndContinueGen = (async function* (): AsyncGenerator<WalkthroughStreamEvent> {
									yield { type: 'summary' as const, data: { summary: partial.summary, riskLevel: partial.riskLevel } };
									for (const block of existingBlocks) {
										yield { type: 'block' as const, data: block };
									}
									yield* continuationGenerator;
								})();
								return {
									generator: replayAndContinueGen,
									reviewSessionId: reviewSession.id,
									prId: pr.id,
									headSha: meta.headSha,
									modelUsed: 'claude-sonnet-4-20250514',
									existingWalkthroughId: partial.id,
									resumeFromBlockCount: existingBlocks.length,
								};
							}
							yield* walkthroughService.invalidateForPr(pr.id);
						}

						// ── Check cache ──────────────────────────────────────────────
						const cached = yield* walkthroughService.getCached(pr.id, meta.headSha);
						if (cached) {
							const replayGen = (async function* (): AsyncGenerator<WalkthroughStreamEvent> {
								yield { type: 'summary' as const, data: { summary: cached.summary, riskLevel: cached.riskLevel } };
								for (const block of cached.blocks) {
									yield { type: 'block' as const, data: block };
								}
								for (const issue of cached.issues) {
									yield { type: 'issue' as const, data: issue };
								}
								yield { type: 'done' as const, data: { walkthroughId: cached.id, tokenUsage: cached.tokenUsage } };
							})();
							return {
								generator: replayGen,
								reviewSessionId: cached.reviewSessionId,
								prId: pr.id,
								headSha: meta.headSha,
								modelUsed: cached.modelUsed,
								existingWalkthroughId: undefined as string | undefined,
								resumeFromBlockCount: 0,
							};
						}

						// ── Stream from AI ───────────────────────────────────────────
						const reviewSession = yield* reviewService.getOrCreateActiveSession(pr.id);
						const generator = yield* ai.streamWalkthrough({
							pr: {
								title: pr.title,
								body: pr.body,
								sourceBranch: pr.sourceBranch,
								targetBranch: pr.targetBranch,
								url: pr.url,
							},
							files,
							worktreePath,
						});
						return {
							generator,
							reviewSessionId: reviewSession.id,
							prId: pr.id,
							headSha: meta.headSha,
							modelUsed: 'claude-sonnet-4-20250514',
							existingWalkthroughId: undefined as string | undefined,
							resumeFromBlockCount: 0,
						};
				}).pipe(
					Effect.timeout(Duration.minutes(2)),
					Effect.catchTag('TimeoutException', () => Effect.fail(new Error('AI setup timed out after 2 minutes.'))),
				),
			);

			// ── Run the generator, persisting events and streaming to client ─
			// If resuming, pre-set walkthroughId so we don't create a new partial row
			try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'phase', data: { phase: 'connecting', message: 'Waiting for AI response...' } })}\n\n`)); } catch { return; }
			walkthroughId = existingWalkthroughId ?? null;
				let collectedSummary = '';
				let collectedRiskLevel: RiskLevel = 'low';
				let issueOrderCounter = 0;

				for await (const event of generator) {
					debug('walkthrough-sse', 'got event:', event.type);

					// ── Persist regardless of client connection ──────────────
					if (event.type === 'summary') {
						collectedSummary = event.data.summary;
						collectedRiskLevel = event.data.riskLevel;
						if (walkthroughId === null) {
							// Fresh generation — create the partial walkthrough row immediately
							walkthroughId = await AppRuntime.runPromise(
								Effect.gen(function* () {
									const ws = yield* WalkthroughService;
									return yield* ws.createPartial({
										reviewSessionId,
										prId,
										summary: collectedSummary,
										riskLevel: collectedRiskLevel,
										modelUsed,
										prHeadSha: headSha,
									});
								}),
							);
						}
						// Resume path: walkthroughId is already set from existingWalkthroughId, skip createPartial
					} else if (event.type === 'block' && walkthroughId !== null) {
						// Skip persisting replayed blocks (already in DB) — only persist new blocks
						const isReplayedBlock = event.data.order < resumeFromBlockCount;
						if (!isReplayedBlock) {
							const capturedId = walkthroughId;
							await AppRuntime.runPromise(
								Effect.gen(function* () {
									const ws = yield* WalkthroughService;
									yield* ws.addBlock(capturedId, event.data);
								}),
							).catch((err) => {
								logError('walkthrough-sse', 'Failed to persist block:', err);
							});
						}
					} else if (event.type === 'issue' && walkthroughId !== null) {
						const capturedId = walkthroughId;
						const issueOrder = issueOrderCounter++;
						await AppRuntime.runPromise(
							Effect.gen(function* () {
								const ws = yield* WalkthroughService;
								yield* ws.addIssue(capturedId, event.data, issueOrder);
							}),
						).catch((err) => {
							logError('walkthrough-sse', 'Failed to persist issue:', err);
						});
					} else if (event.type === 'done' && walkthroughId !== null) {
						const capturedId = walkthroughId;
						await AppRuntime.runPromise(
							Effect.gen(function* () {
								const ws = yield* WalkthroughService;
								yield* ws.markComplete(capturedId, event.data.tokenUsage);
							}),
						).catch((err) => {
							logError('walkthrough-sse', 'Failed to mark walkthrough complete:', err);
						});
						// Broadcast completion via WebSocket so background listeners are notified
						await AppRuntime.runPromise(
							Effect.gen(function* () {
								const hub = yield* WebSocketHub;
								yield* hub.broadcast({ type: 'walkthrough:complete', data: { prId, walkthroughId: capturedId } });
							}),
						).catch(() => { /* best-effort */ });
						// Overwrite empty walkthroughId in done event with real ID before sending
						if (!cancelled) {
							const doneEvent = { ...event, data: { ...event.data, walkthroughId: capturedId } };
							try {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneEvent)}\n\n`));
							} catch { cancelled = true; }
						}
						continue;
					}

					// ── Stream to SSE only if client is still connected ─────
					if (!cancelled) {
						try {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
						} catch {
							// Client disconnected — continue generating in background
							cancelled = true;
							debug('walkthrough-sse', 'client disconnected, continuing generation in background');
						}
					}
				}

				if (!cancelled) {
					try {
						controller.enqueue(encoder.encode('data: [DONE]\n\n'));
						controller.close();
					} catch { /* controller already closed */ }
				}
			} catch (err) {
				// Covers both setup errors (git clone, DB, auth) and generator errors
				logError('walkthrough-sse', 'Walkthrough error:', err);
				if (walkthroughId !== null) {
					const capturedId = walkthroughId;
					AppRuntime.runPromise(
						Effect.gen(function* () {
							const ws = yield* WalkthroughService;
							yield* ws.markError(capturedId);
						}),
					).catch(() => { /* best-effort */ });
				}
				const e = unwrapEffectError(err);
				const message = e instanceof Error ? e.message : 'Walkthrough generation failed';
				// Broadcast error via WebSocket so background listeners are notified
				AppRuntime.runPromise(
					Effect.gen(function* () {
						const hub = yield* WebSocketHub;
						yield* hub.broadcast({ type: 'walkthrough:error', data: { prId: ctx.params.id, message } });
					}),
				).catch(() => { /* best-effort */ });
				try {
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify({ type: 'error', data: { code: 'GENERATION_ERROR', message } })}\n\n`),
					);
				} catch { /* controller may be closed */ }
				try { controller.close(); } catch { /* already closed */ }
			} finally {
				clearInterval(heartbeat);
			}
		})();

		return new Response(sseStream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			},
		});
	})

	// GET /api/reviews/:id/walkthrough/cached — check cache status
	.get('/:id/walkthrough/cached', async (ctx) => {
		try {
			return await AppRuntime.runPromise(
				Effect.gen(function* () {
					const prService = yield* PullRequestService;
					const repoService = yield* RepositoryService;
					const tokenProvider = yield* TokenProvider;
					const github = yield* GitHubService;
					const walkthroughService = yield* WalkthroughService;

					const pr = yield* prService.getPr(ctx.params.id);
					const repo = yield* repoService.getRepoById(pr.repositoryId);
					const ghToken = yield* tokenProvider.getGitHubToken(ctx.session.user.id);
					const meta = yield* github.getPrMeta(repo.fullName, pr.externalId, ghToken);

					const cached = yield* walkthroughService.getCached(pr.id, meta.headSha);
					if (cached) {
						return { cached: true as const, walkthrough: cached };
					}
					return { cached: false as const };
				}),
			);
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

	// POST /api/reviews/:id/walkthrough/regenerate — clear cache
	.post('/:id/walkthrough/regenerate', async (ctx) => {
		try {
			await AppRuntime.runPromise(
				Effect.gen(function* () {
					const walkthroughService = yield* WalkthroughService;
					yield* walkthroughService.invalidateForPr(ctx.params.id);
				}),
			);
			return { success: true };
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

	// POST /api/reviews/:id/github-submit — submit a review to GitHub
	.post(
		'/:id/github-submit',
		async (ctx) => {
			try {
				const result = await AppRuntime.runPromise(
					Effect.gen(function* () {
						const prService = yield* PullRequestService;
						const repoService = yield* RepositoryService;
						const tokenProvider = yield* TokenProvider;
						const github = yield* GitHubService;

						const pr = yield* prService.getPr(ctx.params.id);
						const repo = yield* repoService.getRepoById(pr.repositoryId);
						const ghToken = yield* tokenProvider.getGitHubToken(ctx.session.user.id);

						const eventMap = {
							approve: 'APPROVE',
							request_changes: 'REQUEST_CHANGES',
							comment: 'COMMENT',
						} as const;

						const comments = (ctx.body.comments ?? []).map((c) => {
							const comment: {
								path: string;
								body: string;
								line: number;
								side: 'LEFT' | 'RIGHT';
								startLine?: number;
								startSide?: 'LEFT' | 'RIGHT';
							} = {
								path: c.path,
								body: c.body,
								line: c.line,
								side: c.side,
							};
							if (c.startLine !== undefined && c.startLine !== c.line) {
								comment.startLine = c.startLine;
								comment.startSide = c.side;
							}
							return comment;
						});

						return yield* github.postReview(
							repo.fullName,
							pr.externalId,
							{
								event: eventMap[ctx.body.action],
								body: ctx.body.body ?? '',
								comments,
							},
							ghToken,
						);
					}),
				);
				return result;
			} catch (e) {
				return handleAppError(e, ctx);
			}
		},
		{
			body: t.Object({
				action: t.Union([
					t.Literal('approve'),
					t.Literal('request_changes'),
					t.Literal('comment'),
				]),
				body: t.Optional(t.String()),
				comments: t.Optional(
					t.Array(
						t.Object({
							path: t.String(),
							body: t.String(),
							line: t.Number(),
							side: t.Union([t.Literal('LEFT'), t.Literal('RIGHT')]),
							startLine: t.Optional(t.Number()),
						}),
					),
				),
			}),
		},
	);
