import { Context, Effect, Layer } from 'effect';
import { and, eq } from 'drizzle-orm';
import type {
	ReviewSession,
	CommentThread,
	ThreadMessage,
	HunkDecision,
	ThreadStatus,
	AuthorRole,
	MessageType,
	HunkDecisionType,
} from '@rev/shared';
import { ReviewError } from '../domain/errors';
import { reviewSessions } from '../db/schema/review-sessions';
import { commentThreads } from '../db/schema/comment-threads';
import { threadMessages } from '../db/schema/thread-messages';
import { hunkDecisions } from '../db/schema/hunk-decisions';
import { DbService } from './Db';

// ── Row-to-domain converters ─────────────────────────────────────────────────

function rowToSession(row: typeof reviewSessions.$inferSelect): ReviewSession {
	return {
		id: row.id,
		pullRequestId: row.pullRequestId,
		startedAt: row.startedAt,
		completedAt: row.completedAt ?? null,
		status: row.status as ReviewSession['status'],
	};
}

function rowToThread(row: typeof commentThreads.$inferSelect): CommentThread {
	return {
		id: row.id,
		reviewSessionId: row.reviewSessionId,
		filePath: row.filePath,
		startLine: row.startLine,
		endLine: row.endLine,
		diffSide: row.diffSide as CommentThread['diffSide'],
		status: row.status as CommentThread['status'],
		createdAt: row.createdAt,
		resolvedAt: row.resolvedAt ?? null,
	};
}

function rowToMessage(row: typeof threadMessages.$inferSelect): ThreadMessage {
	return {
		id: row.id,
		threadId: row.threadId,
		authorRole: row.authorRole as ThreadMessage['authorRole'],
		authorName: row.authorName,
		body: row.body,
		messageType: row.messageType as ThreadMessage['messageType'],
		codeSuggestion: row.codeSuggestion ?? null,
		createdAt: row.createdAt,
		editedAt: row.editedAt ?? null,
		externalId: row.externalId ?? null,
	};
}

function rowToHunkDecision(row: typeof hunkDecisions.$inferSelect): HunkDecision {
	return {
		id: row.id,
		reviewSessionId: row.reviewSessionId,
		filePath: row.filePath,
		hunkIndex: row.hunkIndex,
		decision: row.decision as HunkDecision['decision'],
		decidedAt: row.decidedAt,
	};
}

// ── Create-params types ──────────────────────────────────────────────────────

export interface CreateThreadParams {
	filePath: string;
	startLine: number;
	endLine: number;
	diffSide: 'old' | 'new';
}

export interface CreateMessageParams {
	authorRole: AuthorRole;
	authorName: string;
	body: string;
	messageType: MessageType;
	codeSuggestion?: string;
}

// ── Service definition ───────────────────────────────────────────────────────

export class ReviewService extends Context.Tag('ReviewService')<
	ReviewService,
	{
		// Sessions
		readonly getOrCreateActiveSession: (
			prId: string,
		) => Effect.Effect<ReviewSession, ReviewError, DbService>;
		readonly completeSession: (
			id: string,
			status: 'completed' | 'abandoned',
		) => Effect.Effect<void, ReviewError, DbService>;

		// Threads
		readonly createThread: (
			sessionId: string,
			params: CreateThreadParams,
		) => Effect.Effect<CommentThread, ReviewError, DbService>;
		readonly getThreadsForSession: (
			sessionId: string,
		) => Effect.Effect<CommentThread[], ReviewError, DbService>;
		readonly getThreadsForFile: (
			sessionId: string,
			filePath: string,
		) => Effect.Effect<CommentThread[], ReviewError, DbService>;
		readonly updateThreadStatus: (
			threadId: string,
			status: ThreadStatus,
		) => Effect.Effect<CommentThread, ReviewError, DbService>;

		// Messages
		readonly addMessage: (
			threadId: string,
			params: CreateMessageParams,
		) => Effect.Effect<ThreadMessage, ReviewError, DbService>;
		readonly getMessages: (
			threadId: string,
		) => Effect.Effect<ThreadMessage[], ReviewError, DbService>;

		// Hunk decisions
		readonly setHunkDecision: (
			sessionId: string,
			filePath: string,
			hunkIndex: number,
			decision: HunkDecisionType,
		) => Effect.Effect<void, ReviewError, DbService>;
		readonly clearHunkDecision: (
			sessionId: string,
			filePath: string,
			hunkIndex: number,
		) => Effect.Effect<void, ReviewError, DbService>;
		readonly getHunkDecisions: (
			sessionId: string,
		) => Effect.Effect<HunkDecision[], ReviewError, DbService>;
	}
>() {}

// ── Live implementation ──────────────────────────────────────────────────────

export const ReviewServiceLive = Layer.succeed(ReviewService, {
	// ── Sessions ──────────────────────────────────────────────────────────────

	getOrCreateActiveSession: (prId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;

			const existing = db
				.select()
				.from(reviewSessions)
				.where(
					and(
						eq(reviewSessions.pullRequestId, prId),
						eq(reviewSessions.status, 'active'),
					),
				)
				.get();

			if (existing) return rowToSession(existing);

			const id = crypto.randomUUID();
			const startedAt = new Date().toISOString();

			yield* Effect.try({
				try: () =>
					db
						.insert(reviewSessions)
						.values({ id, pullRequestId: prId, startedAt, status: 'active' })
						.run(),
				catch: (e) => new ReviewError({ message: `Failed to create session: ${String(e)}` }),
			});

			return {
				id,
				pullRequestId: prId,
				startedAt,
				completedAt: null,
				status: 'active' as const,
			};
		}),

	completeSession: (id, status) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;

			const existing = db
				.select()
				.from(reviewSessions)
				.where(eq(reviewSessions.id, id))
				.get();

			if (!existing) {
				return yield* Effect.fail(
					new ReviewError({ message: 'Session not found', code: 'NOT_FOUND' }),
				);
			}

			yield* Effect.try({
				try: () =>
					db
						.update(reviewSessions)
						.set({ status, completedAt: new Date().toISOString() })
						.where(eq(reviewSessions.id, id))
						.run(),
				catch: (e) =>
					new ReviewError({ message: `Failed to update session: ${String(e)}` }),
			});
		}),

	// ── Threads ───────────────────────────────────────────────────────────────

	createThread: (sessionId, params) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const id = crypto.randomUUID();
			const createdAt = new Date().toISOString();

			const row = {
				id,
				reviewSessionId: sessionId,
				filePath: params.filePath,
				startLine: params.startLine,
				endLine: params.endLine,
				diffSide: params.diffSide,
				status: 'open' as const,
				createdAt,
			} satisfies typeof commentThreads.$inferInsert;

			yield* Effect.try({
				try: () => db.insert(commentThreads).values(row).run(),
				catch: (e) =>
					new ReviewError({ message: `Failed to create thread: ${String(e)}` }),
			});

			return {
				id,
				reviewSessionId: sessionId,
				filePath: params.filePath,
				startLine: params.startLine,
				endLine: params.endLine,
				diffSide: params.diffSide,
				status: 'open' as const,
				createdAt,
				resolvedAt: null,
			};
		}),

	getThreadsForSession: (sessionId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const rows = db
				.select()
				.from(commentThreads)
				.where(eq(commentThreads.reviewSessionId, sessionId))
				.all();
			return rows.map(rowToThread);
		}),

	getThreadsForFile: (sessionId, filePath) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const rows = db
				.select()
				.from(commentThreads)
				.where(
					and(
						eq(commentThreads.reviewSessionId, sessionId),
						eq(commentThreads.filePath, filePath),
					),
				)
				.all();
			return rows.map(rowToThread);
		}),

	updateThreadStatus: (threadId, status) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;

			const existing = db
				.select()
				.from(commentThreads)
				.where(eq(commentThreads.id, threadId))
				.get();

			if (!existing) {
				return yield* Effect.fail(
					new ReviewError({ message: 'Thread not found', code: 'NOT_FOUND' }),
				);
			}

			const isResolving = status === 'resolved' || status === 'wont_fix';
			const isReopening = status === 'open' || status === 'pending_coder' || status === 'pending_reviewer';

			const updates: Partial<typeof commentThreads.$inferInsert> = { status };
			if (isResolving) {
				updates.resolvedAt = new Date().toISOString();
			} else if (isReopening) {
				updates.resolvedAt = undefined; // Drizzle treats undefined as "don't set" — use null
			}

			// For clearing resolvedAt on reopen, we need to set it explicitly to null
			yield* Effect.try({
				try: () => {
					if (isReopening) {
						db.update(commentThreads)
							.set({ status, resolvedAt: null })
							.where(eq(commentThreads.id, threadId))
							.run();
					} else if (isResolving) {
						db.update(commentThreads)
							.set({ status, resolvedAt: new Date().toISOString() })
							.where(eq(commentThreads.id, threadId))
							.run();
					} else {
						db.update(commentThreads)
							.set({ status })
							.where(eq(commentThreads.id, threadId))
							.run();
					}
				},
				catch: (e) =>
					new ReviewError({ message: `Failed to update thread: ${String(e)}` }),
			});

			const updated = db
				.select()
				.from(commentThreads)
				.where(eq(commentThreads.id, threadId))
				.get();

			return rowToThread(updated!);
		}),

	// ── Messages ──────────────────────────────────────────────────────────────

	addMessage: (threadId, params) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const id = crypto.randomUUID();
			const createdAt = new Date().toISOString();

			const row = {
				id,
				threadId,
				authorRole: params.authorRole,
				authorName: params.authorName,
				body: params.body,
				messageType: params.messageType,
				...(params.codeSuggestion !== undefined
					? { codeSuggestion: params.codeSuggestion }
					: {}),
				createdAt,
			} satisfies typeof threadMessages.$inferInsert;

			yield* Effect.try({
				try: () => db.insert(threadMessages).values(row).run(),
				catch: (e) =>
					new ReviewError({ message: `Failed to add message: ${String(e)}` }),
			});

			return {
				id,
				threadId,
				authorRole: params.authorRole as ThreadMessage['authorRole'],
				authorName: params.authorName,
				body: params.body,
				messageType: params.messageType as ThreadMessage['messageType'],
				codeSuggestion: params.codeSuggestion ?? null,
				createdAt,
				editedAt: null,
				externalId: null,
			};
		}),

	getMessages: (threadId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const rows = db
				.select()
				.from(threadMessages)
				.where(eq(threadMessages.threadId, threadId))
				.orderBy(threadMessages.createdAt)
				.all();
			return rows.map(rowToMessage);
		}),

	// ── Hunk decisions ────────────────────────────────────────────────────────

	setHunkDecision: (sessionId, filePath, hunkIndex, decision) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const id = crypto.randomUUID();
			const decidedAt = new Date().toISOString();

			yield* Effect.try({
				try: () =>
					db
						.insert(hunkDecisions)
						.values({ id, reviewSessionId: sessionId, filePath, hunkIndex, decision, decidedAt })
						.onConflictDoUpdate({
							target: [
								hunkDecisions.reviewSessionId,
								hunkDecisions.filePath,
								hunkDecisions.hunkIndex,
							],
							set: { decision, decidedAt },
						})
						.run(),
				catch: (e) =>
					new ReviewError({ message: `Failed to set hunk decision: ${String(e)}` }),
			});
		}),

	clearHunkDecision: (sessionId, filePath, hunkIndex) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			yield* Effect.try({
				try: () =>
					db
						.delete(hunkDecisions)
						.where(
							and(
								eq(hunkDecisions.reviewSessionId, sessionId),
								eq(hunkDecisions.filePath, filePath),
								eq(hunkDecisions.hunkIndex, hunkIndex),
							),
						)
						.run(),
				catch: (e) =>
					new ReviewError({ message: `Failed to clear hunk decision: ${String(e)}` }),
			});
		}),

	getHunkDecisions: (sessionId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const rows = db
				.select()
				.from(hunkDecisions)
				.where(eq(hunkDecisions.reviewSessionId, sessionId))
				.all();
			return rows.map(rowToHunkDecision);
		}),
});
