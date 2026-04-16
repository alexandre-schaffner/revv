import { Elysia, t } from 'elysia';
import { Effect } from 'effect';
import { AppRuntime } from '../runtime';
import { ReviewService } from '../services/Review';
import { WebSocketHub } from '../services/WebSocketHub';
import type { ThreadStatus } from '@rev/shared';
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

						const thread = yield* reviewService.updateThreadStatus(
							ctx.params.id,
							ctx.body.status as ThreadStatus,
						);

						yield* hub.broadcast({
							type: 'thread:updated',
							data: { threadId: ctx.params.id, status: thread.status },
						});

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

						const msg = yield* reviewService.addMessage(ctx.params.id, {
							authorRole: ctx.body.authorRole,
							authorName: ctx.body.authorName,
							body: ctx.body.body,
							messageType: ctx.body.messageType,
							...(ctx.body.codeSuggestion !== undefined
								? { codeSuggestion: ctx.body.codeSuggestion }
								: {}),
						});

						yield* hub.broadcast({
							type: 'thread:message',
							data: { threadId: ctx.params.id, message: msg },
						});

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
