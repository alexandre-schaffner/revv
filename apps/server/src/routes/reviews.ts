import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { auth } from '../auth';
import { AppRuntime } from '../runtime';
import { ReviewService } from '../services/Review';
import { WebSocketHub } from '../services/WebSocketHub';
import { ReviewError } from '../domain/errors';

function isReviewError(e: unknown): e is ReviewError {
	return e instanceof ReviewError ||
		(e !== null && typeof e === 'object' && '_tag' in e && (e as { _tag: unknown })._tag === 'ReviewError');
}

export const reviewRoutes = new Elysia({ prefix: '/api/reviews' })
	// GET /api/reviews/active/:prId — get or create the active session, fully hydrated
	.get('/active/:prId', async (ctx) => {
		const session = await auth.api.getSession({ headers: ctx.request.headers });
		if (!session) {
			ctx.set.status = 401;
			return { error: 'Unauthorized' };
		}

		try {
			return await AppRuntime.runPromise(
				Effect.gen(function* () {
					const reviewService = yield* ReviewService;

					const reviewSession = yield* reviewService.getOrCreateActiveSession(
						ctx.params.prId,
					);

					const threads = yield* reviewService.getThreadsForSession(reviewSession.id);

					// Load messages for all threads
					const messages: Record<string, import('@rev/shared').ThreadMessage[]> = {};
					for (const thread of threads) {
						messages[thread.id] = yield* reviewService.getMessages(thread.id);
					}

					const hunkDecisions = yield* reviewService.getHunkDecisions(reviewSession.id);

					return { session: reviewSession, threads, messages, hunkDecisions };
				}),
			);
		} catch (e) {
			if (isReviewError(e)) {
				ctx.set.status = 500;
				return { error: e.message };
			}
			throw e;
		}
	})

	// POST /api/reviews — create a new session
	.post(
		'/',
		async (ctx) => {
			const session = await auth.api.getSession({ headers: ctx.request.headers });
			if (!session) {
				ctx.set.status = 401;
				return { error: 'Unauthorized' };
			}

			try {
				return await AppRuntime.runPromise(
					Effect.flatMap(ReviewService, (s) =>
						s.getOrCreateActiveSession(ctx.body.pullRequestId),
					),
				);
			} catch (e) {
				if (isReviewError(e)) {
					ctx.set.status = 500;
					return { error: e.message };
				}
				throw e;
			}
		},
		{ body: t.Object({ pullRequestId: t.String() }) },
	)

	// PATCH /api/reviews/:id — complete or abandon a session
	.patch(
		'/:id',
		async (ctx) => {
			const session = await auth.api.getSession({ headers: ctx.request.headers });
			if (!session) {
				ctx.set.status = 401;
				return { error: 'Unauthorized' };
			}

			try {
				await AppRuntime.runPromise(
					Effect.flatMap(ReviewService, (s) =>
						s.completeSession(ctx.params.id, ctx.body.status),
					),
				);
				return { success: true };
			} catch (e) {
				if (isReviewError(e)) {
					if (e.code === 'NOT_FOUND') {
						ctx.set.status = 404;
						return { error: 'Session not found' };
					}
					ctx.set.status = 500;
					return { error: e.message };
				}
				throw e;
			}
		},
		{ body: t.Object({ status: t.Union([t.Literal('completed'), t.Literal('abandoned')]) }) },
	)

	// GET /api/reviews/:id/threads — list threads for a session
	.get(
		'/:id/threads',
		async (ctx) => {
			const session = await auth.api.getSession({ headers: ctx.request.headers });
			if (!session) {
				ctx.set.status = 401;
				return { error: 'Unauthorized' };
			}

			return AppRuntime.runPromise(
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
		},
		{ query: t.Object({ filePath: t.Optional(t.String()) }) },
	)

	// POST /api/reviews/:id/threads — create a thread with initial message
	.post(
		'/:id/threads',
		async (ctx) => {
			const session = await auth.api.getSession({ headers: ctx.request.headers });
			if (!session) {
				ctx.set.status = 401;
				return { error: 'Unauthorized' };
			}

			try {
				const result = await AppRuntime.runPromise(
					Effect.gen(function* () {
						const reviewService = yield* ReviewService;
						const hub = yield* WebSocketHub;

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

						yield* hub.broadcast({
							type: 'thread:created',
							data: { sessionId: ctx.params.id, thread, message },
						});

						return { thread, message };
					}),
				);

				ctx.set.status = 201;
				return result;
			} catch (e) {
				if (isReviewError(e)) {
					ctx.set.status = 500;
					return { error: e.message };
				}
				throw e;
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
		const session = await auth.api.getSession({ headers: ctx.request.headers });
		if (!session) {
			ctx.set.status = 401;
			return { error: 'Unauthorized' };
		}

		return AppRuntime.runPromise(
			Effect.flatMap(ReviewService, (s) => s.getHunkDecisions(ctx.params.id)),
		);
	})

	// PUT /api/reviews/:id/hunks — set a hunk decision (upsert)
	.put(
		'/:id/hunks',
		async (ctx) => {
			const session = await auth.api.getSession({ headers: ctx.request.headers });
			if (!session) {
				ctx.set.status = 401;
				return { error: 'Unauthorized' };
			}

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
		const session = await auth.api.getSession({ headers: ctx.request.headers });
		if (!session) {
			ctx.set.status = 401;
			return { error: 'Unauthorized' };
		}

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
	});
