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
} from '@revv/shared';
import { ReviewError } from '../domain/errors';
import { reviewSessions } from '../db/schema/review-sessions';
import { commentThreads } from '../db/schema/comment-threads';
import { threadMessages } from '../db/schema/thread-messages';
import { hunkDecisions } from '../db/schema/hunk-decisions';
import { DbService } from './Db';
import { tryDb } from '../effects/db-try';

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
		externalThreadId: row.externalThreadId ?? null,
		externalCommentId: row.externalCommentId ?? null,
		lastSyncedAt: row.lastSyncedAt ?? null,
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
	externalThreadId?: string;
	externalCommentId?: string;
	lastSyncedAt?: string;
}

export interface CreateMessageParams {
	authorRole: AuthorRole;
	authorName: string;
	body: string;
	messageType: MessageType;
	codeSuggestion?: string;
	externalId?: string;
	createdAt?: string;
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
		readonly getThread: (
			threadId: string,
		) => Effect.Effect<CommentThread, ReviewError, DbService>;
		readonly getThreadsForSession: (
			sessionId: string,
		) => Effect.Effect<CommentThread[], ReviewError, DbService>;
		readonly getThreadsForFile: (
			sessionId: string,
			filePath: string,
		) => Effect.Effect<CommentThread[], ReviewError, DbService>;
		readonly getThreadByExternalCommentId: (
			sessionId: string,
			externalCommentId: string,
		) => Effect.Effect<CommentThread | null, ReviewError, DbService>;
		readonly updateThreadStatus: (
			threadId: string,
			status: ThreadStatus,
		) => Effect.Effect<CommentThread, ReviewError, DbService>;
		readonly setThreadExternalIds: (
			threadId: string,
			ids: { externalThreadId?: string; externalCommentId?: string; lastSyncedAt?: string },
		) => Effect.Effect<void, ReviewError, DbService>;
		/**
		 * Apply the status-machine transition for a reply by `authorRole`.
		 * Reviewer → pending_coder; Coder → pending_reviewer; AI → unchanged.
		 * Only transitions from open/pending_* states — never reopens resolved threads.
		 * Returns the resulting (possibly unchanged) thread.
		 */
		readonly transitionStatus: (
			threadId: string,
			authorRole: AuthorRole,
		) => Effect.Effect<CommentThread, ReviewError, DbService>;
		readonly deleteThread: (
			threadId: string,
		) => Effect.Effect<void, ReviewError, DbService>;

		// Messages
		readonly addMessage: (
			threadId: string,
			params: CreateMessageParams,
		) => Effect.Effect<ThreadMessage, ReviewError, DbService>;
		readonly getMessages: (
			threadId: string,
		) => Effect.Effect<ThreadMessage[], ReviewError, DbService>;
		readonly getMessage: (
			messageId: string,
		) => Effect.Effect<ThreadMessage, ReviewError, DbService>;
		readonly setMessageExternalId: (
			messageId: string,
			externalId: string,
		) => Effect.Effect<void, ReviewError, DbService>;
		readonly updateMessageBody: (
			messageId: string,
			body: string,
			editedAt: string,
		) => Effect.Effect<void, ReviewError, DbService>;
		readonly editMessage: (
			messageId: string,
			body: string,
		) => Effect.Effect<ThreadMessage, ReviewError, DbService>;
		readonly findMessageByExternalId: (
			externalId: string,
		) => Effect.Effect<ThreadMessage | null, ReviewError, DbService>;

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

			yield* tryDb('create session', (db) =>
				db
					.insert(reviewSessions)
					.values({ id, pullRequestId: prId, startedAt, status: 'active' })
					.run(),
			);

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

			yield* tryDb('update session', (db) =>
				db
					.update(reviewSessions)
					.set({ status, completedAt: new Date().toISOString() })
					.where(eq(reviewSessions.id, id))
					.run(),
			);
		}),

	// ── Threads ───────────────────────────────────────────────────────────────

	createThread: (sessionId, params) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const id = crypto.randomUUID();
			const createdAt = new Date().toISOString();

			const row: typeof commentThreads.$inferInsert = {
				id,
				reviewSessionId: sessionId,
				filePath: params.filePath,
				startLine: params.startLine,
				endLine: params.endLine,
				diffSide: params.diffSide,
				status: 'open',
				createdAt,
			};
			if (params.externalThreadId !== undefined) row.externalThreadId = params.externalThreadId;
			if (params.externalCommentId !== undefined) row.externalCommentId = params.externalCommentId;
			if (params.lastSyncedAt !== undefined) row.lastSyncedAt = params.lastSyncedAt;

			yield* tryDb('create thread', (db) =>
				db.insert(commentThreads).values(row).run(),
			);

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
				externalThreadId: params.externalThreadId ?? null,
				externalCommentId: params.externalCommentId ?? null,
				lastSyncedAt: params.lastSyncedAt ?? null,
			};
		}),

	getThread: (threadId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const row = db.select().from(commentThreads).where(eq(commentThreads.id, threadId)).get();
			if (!row) {
				return yield* Effect.fail(
					new ReviewError({ message: 'Thread not found', code: 'NOT_FOUND' }),
				);
			}
			return rowToThread(row);
		}),

	getThreadByExternalCommentId: (sessionId, externalCommentId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const row = db
				.select()
				.from(commentThreads)
				.where(
					and(
						eq(commentThreads.reviewSessionId, sessionId),
						eq(commentThreads.externalCommentId, externalCommentId),
					),
				)
				.get();
			return row ? rowToThread(row) : null;
		}),

	setThreadExternalIds: (threadId, ids) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const setObj: Partial<typeof commentThreads.$inferInsert> = {};
			if (ids.externalThreadId !== undefined) setObj.externalThreadId = ids.externalThreadId;
			if (ids.externalCommentId !== undefined) setObj.externalCommentId = ids.externalCommentId;
			if (ids.lastSyncedAt !== undefined) setObj.lastSyncedAt = ids.lastSyncedAt;
			if (Object.keys(setObj).length === 0) return;
			yield* tryDb('update thread IDs', (db) =>
				db.update(commentThreads).set(setObj).where(eq(commentThreads.id, threadId)).run(),
			);
		}),

	transitionStatus: (threadId, authorRole) =>
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
			// AI messages never change status; resolved/wont_fix are terminal until an
			// explicit reopen — replies don't auto-reopen.
			if (authorRole === 'ai_agent') return rowToThread(existing);
			if (existing.status === 'resolved' || existing.status === 'wont_fix') {
				return rowToThread(existing);
			}
			const nextStatus: ThreadStatus =
				authorRole === 'reviewer' ? 'pending_coder' : 'pending_reviewer';
			if (nextStatus === existing.status) return rowToThread(existing);
			yield* tryDb('transition thread status', (db) =>
				db
					.update(commentThreads)
					.set({ status: nextStatus })
					.where(eq(commentThreads.id, threadId))
					.run(),
			);
			return rowToThread({ ...existing, status: nextStatus });
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

	deleteThread: (threadId) =>
		Effect.gen(function* () {
			yield* tryDb('delete thread', (db) =>
				db.delete(commentThreads).where(eq(commentThreads.id, threadId)).run(),
			);
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

			yield* tryDb('update thread', (db) => {
				const setObj: Partial<typeof commentThreads.$inferInsert> = { status };
				if (isResolving) setObj.resolvedAt = new Date().toISOString();
				else if (isReopening) setObj.resolvedAt = null;
				db.update(commentThreads).set(setObj).where(eq(commentThreads.id, threadId)).run();
			});

			const updated = db
				.select()
				.from(commentThreads)
				.where(eq(commentThreads.id, threadId))
				.get();

			if (!updated) {
				return yield* Effect.fail(
					new ReviewError({
						message: 'Thread disappeared after update',
						code: 'NOT_FOUND',
					}),
				);
			}

			return rowToThread(updated);
		}),

	// ── Messages ──────────────────────────────────────────────────────────────

	addMessage: (threadId, params) =>
		Effect.gen(function* () {
			const id = crypto.randomUUID();
			const createdAt = params.createdAt ?? new Date().toISOString();

			const row: typeof threadMessages.$inferInsert = {
				id,
				threadId,
				authorRole: params.authorRole,
				authorName: params.authorName,
				body: params.body,
				messageType: params.messageType,
				createdAt,
			};
			if (params.codeSuggestion !== undefined) row.codeSuggestion = params.codeSuggestion;
			if (params.externalId !== undefined) row.externalId = params.externalId;

			yield* tryDb('add message', (db) =>
				db.insert(threadMessages).values(row).run(),
			);

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
				externalId: params.externalId ?? null,
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

	getMessage: (messageId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const row = db
				.select()
				.from(threadMessages)
				.where(eq(threadMessages.id, messageId))
				.get();
			if (!row) {
				return yield* Effect.fail(
					new ReviewError({ message: 'Message not found', code: 'NOT_FOUND' }),
				);
			}
			return rowToMessage(row);
		}),

	setMessageExternalId: (messageId, externalId) =>
		tryDb('set message externalId', (db) =>
			db
				.update(threadMessages)
				.set({ externalId })
				.where(eq(threadMessages.id, messageId))
				.run(),
		).pipe(Effect.asVoid),

	updateMessageBody: (messageId, body, editedAt) =>
		tryDb('update message body', (db) =>
			db
				.update(threadMessages)
				.set({ body, editedAt })
				.where(eq(threadMessages.id, messageId))
				.run(),
		).pipe(Effect.asVoid),

	editMessage: (messageId, body) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;

			const msgRow = db
				.select()
				.from(threadMessages)
				.where(eq(threadMessages.id, messageId))
				.get();

			if (!msgRow) {
				return yield* Effect.fail(
					new ReviewError({ message: 'Message not found', code: 'NOT_FOUND' }),
				);
			}

			const threadRow = db
				.select()
				.from(commentThreads)
				.where(eq(commentThreads.id, msgRow.threadId))
				.get();

			if (!threadRow) {
				return yield* Effect.fail(
					new ReviewError({ message: 'Thread not found', code: 'NOT_FOUND' }),
				);
			}

			if (threadRow.externalCommentId !== null) {
				return yield* Effect.fail(
					new ReviewError({
						message: 'Cannot edit a message that has already been synced to GitHub',
						code: 'FORBIDDEN',
					}),
				);
			}

			const editedAt = new Date().toISOString();

			yield* tryDb('edit message', (d) =>
				d
					.update(threadMessages)
					.set({ body, editedAt })
					.where(eq(threadMessages.id, messageId))
					.run(),
			);

			return rowToMessage({ ...msgRow, body, editedAt });
		}),

	findMessageByExternalId: (externalId) =>
		Effect.gen(function* () {
			const { db } = yield* DbService;
			const row = db
				.select()
				.from(threadMessages)
				.where(eq(threadMessages.externalId, externalId))
				.get();
			return row ? rowToMessage(row) : null;
		}),

	// ── Hunk decisions ────────────────────────────────────────────────────────

	setHunkDecision: (sessionId, filePath, hunkIndex, decision) => {
		const id = crypto.randomUUID();
		const decidedAt = new Date().toISOString();
		return tryDb('set hunk decision', (db) =>
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
		).pipe(Effect.asVoid);
	},

	clearHunkDecision: (sessionId, filePath, hunkIndex) =>
		tryDb('clear hunk decision', (db) =>
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
		).pipe(Effect.asVoid),

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
