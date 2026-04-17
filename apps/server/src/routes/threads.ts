import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { AppRuntime } from '../runtime';
import { ReviewService } from '../services/Review';
import { SyncService } from '../services/Sync';
import { WebSocketHub } from '../services/WebSocketHub';
import type { ThreadStatus } from '@revv/shared';
import { withAuth, handleAppError } from './middleware';

export const threadRoutes = new Elysia({ prefix: '/api/threads' })
	.use(withAuth)
	// PATCH /api/threads/:id — update thread status
	.patch(
		'/:id',
		async (ctx) => {
			try {
				const updated = await AppRuntime.runPromise(
					Effect.gen(function* () {
						const reviewService = yield* ReviewService;
						const hub = yield* WebSocketHub;
						const sync = yield* SyncService;

						const thread = yield* reviewService.updateThreadStatus(
							ctx.params.id,
							ctx.body.status as ThreadStatus,
						);

						yield* hub.broadcast({
							type: 'thread:updated',
							data: { threadId: ctx.params.id, status: thread.status },
						});

						// Push resolve/unresolve to GitHub if the thread has been synced.
						// Best-effort — don't fail the local update if GitHub push fails.
						yield* sync.pushThreadStatus(ctx.params.id).pipe(
							Effect.catchAll(() => Effect.void),
						);

						return thread;
					}),
				);

				return updated;
			} catch (e) {
				return handleAppError(e, ctx);
			}
		},
		{
			body: t.Object({
				status: t.Union([
					t.Literal('open'),
					t.Literal('pending_coder'),
					t.Literal('pending_reviewer'),
					t.Literal('resolved'),
					t.Literal('wont_fix'),
				]),
			}),
		},
	)

	// POST /api/threads/:id/reopen — convenience endpoint that flips to open + syncs
	.post('/:id/reopen', async (ctx) => {
		try {
			const updated = await AppRuntime.runPromise(
				Effect.gen(function* () {
					const reviewService = yield* ReviewService;
					const hub = yield* WebSocketHub;
					const sync = yield* SyncService;

					const thread = yield* reviewService.updateThreadStatus(ctx.params.id, 'open');
					yield* hub.broadcast({
						type: 'thread:updated',
						data: { threadId: ctx.params.id, status: thread.status },
					});
					yield* sync.pushThreadStatus(ctx.params.id).pipe(
						Effect.catchAll(() => Effect.void),
					);
					return thread;
				}),
			);
			return updated;
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

	// POST /api/threads/:id/push — push this thread to GitHub (create the review comment).
	// Used by the frontend immediately after creating a thread to get it round-tripping.
	.post('/:id/push', async (ctx) => {
		try {
			await AppRuntime.runPromise(
				Effect.flatMap(SyncService, (s) => s.pushThread(ctx.params.id)),
			);
			return { success: true };
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

	// POST /api/threads/:id/messages/:messageId/push — push a single reply.
	.post('/:id/messages/:messageId/push', async (ctx) => {
		try {
			await AppRuntime.runPromise(
				Effect.flatMap(SyncService, (s) => s.pushReply(ctx.params.messageId)),
			);
			return { success: true };
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

	// GET /api/threads/:id/messages — list messages in a thread
	.get('/:id/messages', async (ctx) => {
		try {
			return await AppRuntime.runPromise(
				Effect.flatMap(ReviewService, (s) => s.getMessages(ctx.params.id)),
			);
		} catch (e) {
			return handleAppError(e, ctx);
		}
	})

	// POST /api/threads/:id/messages — add a message to a thread
	.post(
		'/:id/messages',
		async (ctx) => {
			try {
				const message = await AppRuntime.runPromise(
					Effect.gen(function* () {
						const reviewService = yield* ReviewService;
						const hub = yield* WebSocketHub;
						const sync = yield* SyncService;

						const msg = yield* reviewService.addMessage(ctx.params.id, {
							authorRole: ctx.body.authorRole,
							authorName: ctx.body.authorName,
							body: ctx.body.body,
							messageType: ctx.body.messageType,
							...(ctx.body.codeSuggestion !== undefined
								? { codeSuggestion: ctx.body.codeSuggestion }
								: {}),
						});

						// Auto-transition thread status based on author role.
						const transitioned = yield* reviewService
							.transitionStatus(ctx.params.id, ctx.body.authorRole)
							.pipe(Effect.catchAll(() => Effect.succeed(null)));

						yield* hub.broadcast({
							type: 'thread:message',
							data: { threadId: ctx.params.id, message: msg },
						});
						if (transitioned) {
							yield* hub.broadcast({
								type: 'thread:updated',
								data: { threadId: ctx.params.id, status: transitioned.status },
							});
						}

						// Fire-and-forget: push reply to GitHub if the thread is already synced.
						yield* sync.pushReply(msg.id).pipe(Effect.catchAll(() => Effect.void));

						return msg;
					}),
				);

				ctx.set.status = 201;
				return message;
			} catch (e) {
				return handleAppError(e, ctx);
			}
		},
		{
			body: t.Object({
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
		},
	);
