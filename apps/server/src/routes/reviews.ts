import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { AppRuntime } from '../runtime';
import { ReviewService } from '../services/Review';
import { SyncService } from '../services/Sync';
import { WebSocketHub } from '../services/WebSocketHub';
import { withAuth, handleAppError } from './middleware';
import { activeSessionHandler } from './reviews/handlers/active-session';
import { walkthroughStreamHandler } from './reviews/handlers/walkthrough-stream';
import {
	getCachedWalkthroughHandler,
	regenerateWalkthroughHandler,
} from './reviews/handlers/walkthrough-cache';
import { submitGithubReviewHandler } from './reviews/handlers/github-submit';
import type { CarriedOverIssue } from '@revv/shared';

/**
 * Review routes — thin Elysia router. Handler bodies live in
 * `routes/reviews/handlers/*` to keep each file single-purpose.
 *
 * Small CRUD endpoints (threads, hunks, session lifecycle) stay inline here
 * because they're trivial Effect one-liners and extracting them adds more
 * import noise than it removes. Anything non-trivial — notably the SSE
 * walkthrough stream (formerly 370 lines inline) — lives in a handler file.
 */
export const reviewRoutes = new Elysia({ prefix: '/api/reviews' })
	.use(withAuth)

	// ── Session lifecycle ──────────────────────────────────────────────────
	.get('/active/:prId', async (ctx) => {
		try {
			return await activeSessionHandler(ctx.params.prId);
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

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

	// ── Threads ────────────────────────────────────────────────────────────
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

	.post(
		'/:id/threads',
		async (ctx) => {
			try {
				const result = await AppRuntime.runPromise(
					Effect.gen(function* () {
						const reviewService = yield* ReviewService;
						const hub = yield* WebSocketHub;
						// SyncService is kept as a dependency so future auto-push
						// from thread creation can be wired up without changing
						// this handler's shape.
						yield* SyncService;

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
							...(ctx.body.message.authorAvatarUrl !== undefined
								? { authorAvatarUrl: ctx.body.message.authorAvatarUrl }
								: {}),
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
					authorAvatarUrl: t.Optional(t.Union([t.String(), t.Null()])),
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

	// ── Hunk decisions ─────────────────────────────────────────────────────
	.get('/:id/hunks', async (ctx) => {
		try {
			return await AppRuntime.runPromise(
				Effect.flatMap(ReviewService, (s) => s.getHunkDecisions(ctx.params.id)),
			);
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

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

	// ── Walkthrough ────────────────────────────────────────────────────────
	.get('/:id/walkthrough', (ctx) => walkthroughStreamHandler(ctx))

	.get('/:id/walkthrough/cached', async (ctx) => {
		try {
			return await getCachedWalkthroughHandler(ctx.params.id, ctx.session.user.id);
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

	.post('/:id/walkthrough/regenerate', async (ctx) => {
		try {
			const body = ctx.body as { keptIssues?: unknown } | null | undefined;
			const keptIssues = Array.isArray(body?.keptIssues)
				? (body.keptIssues as CarriedOverIssue[])
				: [];
			await regenerateWalkthroughHandler(ctx.params.id, keptIssues);
			return { success: true };
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

	// ── GitHub submission ──────────────────────────────────────────────────
	.post(
		'/:id/github-submit',
		async (ctx) => {
			try {
				return await submitGithubReviewHandler(
					ctx.params.id,
					ctx.session.user.id,
					ctx.body,
				);
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
							threadId: t.String(),
						}),
					),
				),
			}),
		},
	);
