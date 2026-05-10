// ── ChatSession ────────────────────────────────────────────────────────────
//
// Drizzle wrapper around chat persistence: `chat_sessions` (the durable
// thread handle) plus `chat_messages` and `chat_activities` (the transcript
// + structured tool-use rows added in migration 0110).
//
// Two responsibilities:
//
//   1. Session bookkeeping — find/upsert/clear per (prId, agent, prHeadSha),
//      patch in the agent-side session id once the SDK / daemon emits it.
//   2. Transcript persistence — append user messages, stream assistant
//      content into a single row, append typed activity rows. All inserts
//      atomically allocate `chat_sessions.next_sequence` so messages and
//      activities share one monotonic ordering space.
//
// Session sequence allocation runs inside a SQLite transaction so concurrent
// turns (which shouldn't happen for the same PR but could during retries)
// can't double-issue the same sequence number.

import { Context, Effect, Layer } from "effect";
import { and, asc, eq, sql } from "drizzle-orm";
import { DbService } from "./Db";
import { chatActivities, chatMessages, chatSessions } from "../db/schema/index";

export interface ChatSessionRow {
	readonly id: string;
	readonly pullRequestId: string;
	readonly agent: string;
	readonly sessionId: string | null;
	readonly prHeadSha: string;
	readonly worktreePath: string;
	readonly branchName: string;
	readonly nextSequence: number;
	readonly createdAt: string;
	readonly lastActivityAt: string;
}

export interface FindOrCreateChatSessionParams {
	readonly prId: string;
	readonly agent: string;
	readonly prHeadSha: string;
	readonly worktreePath: string;
	readonly branchName: string;
}

export interface UpsertChatSessionParams {
	readonly prId: string;
	readonly agent: string;
	readonly prHeadSha: string;
	readonly sessionId: string;
	readonly worktreePath: string;
	readonly branchName: string;
}

export interface ChatMessageRow {
	readonly id: string;
	readonly chatSessionId: string;
	readonly role: "user" | "assistant";
	readonly content: string;
	readonly isStreaming: boolean;
	readonly sequence: number;
	readonly turnId: string;
	readonly error: string | null;
	readonly createdAt: string;
	readonly finalizedAt: string | null;
}

export interface ChatActivityRow {
	readonly id: string;
	readonly chatSessionId: string;
	readonly turnId: string;
	readonly activityKind: string;
	readonly toolName: string | null;
	readonly summary: string;
	readonly payloadJson: string | null;
	readonly sequence: number;
	readonly createdAt: string;
}

export type ChatTimelineEntry =
	| (ChatMessageRow & { readonly entryKind: "message" })
	| (ChatActivityRow & { readonly entryKind: "activity" });

export class ChatSessionService extends Context.Tag("ChatSessionService")<
	ChatSessionService,
	{
		readonly find: (
			prId: string,
			agent: string,
			prHeadSha: string,
		) => Effect.Effect<ChatSessionRow | null>;
		/**
		 * Look up the existing row for (prId, agent, prHeadSha) or insert a
		 * fresh one with `session_id = NULL`. Used by the chat route at the
		 * START of a turn so subsequent message/activity inserts can FK to
		 * the row before the agent emits its session id (which arrives
		 * mid-stream).
		 */
		readonly findOrCreate: (
			params: FindOrCreateChatSessionParams,
		) => Effect.Effect<ChatSessionRow>;
		/**
		 * Patch the agent-side session id (and refresh worktree/branch which
		 * stay informational) onto an existing row. Called from the route's
		 * `onSessionId` callback.
		 */
		readonly setAgentSessionId: (params: {
			readonly chatSessionId: string;
			readonly sessionId: string;
			readonly worktreePath: string;
			readonly branchName: string;
		}) => Effect.Effect<void>;
		readonly upsert: (
			params: UpsertChatSessionParams,
		) => Effect.Effect<void>;
		/**
		 * Update the prHeadSha of an existing session row. Called by the
		 * merge-and-push flow after a successful push so the session lookup
		 * (keyed on `(prId, agent, prHeadSha)`) keeps finding this conversation
		 * even after `pull_requests.headSha` advances to the freshly pushed tip.
		 */
		readonly updatePrHeadSha: (params: {
			readonly chatSessionId: string;
			readonly prHeadSha: string;
		}) => Effect.Effect<void>;
		readonly clear: (
			prId: string,
			agent: string,
			prHeadSha: string,
		) => Effect.Effect<void>;
		readonly clearAllForPr: (
			prId: string,
			agent: string,
		) => Effect.Effect<void>;
		readonly clearAllForAgent: (agent: string) => Effect.Effect<void>;

		/**
		 * Insert a finalized user message. Returns the row's id + the
		 * allocated sequence (which the caller may include in outgoing SSE
		 * frames once B3 lands).
		 */
		readonly appendUserMessage: (params: {
			readonly chatSessionId: string;
			readonly turnId: string;
			readonly content: string;
		}) => Effect.Effect<{ readonly id: string; readonly sequence: number }>;

		/**
		 * Insert a streaming assistant placeholder. `is_streaming = 1`,
		 * empty content. The route appends content via
		 * `appendAssistantContent` and finalizes via `finalizeAssistantMessage`.
		 */
		readonly beginAssistantMessage: (params: {
			readonly chatSessionId: string;
			readonly turnId: string;
		}) => Effect.Effect<{ readonly id: string; readonly sequence: number }>;

		/** Append `chunk` to the assistant message body in-place. */
		readonly appendAssistantContent: (params: {
			readonly messageId: string;
			readonly chunk: string;
		}) => Effect.Effect<void>;

		/**
		 * Mark the assistant message as no-longer-streaming. If `error` is
		 * set, the inline-error chip text persists for renders that follow.
		 */
		readonly finalizeAssistantMessage: (params: {
			readonly messageId: string;
			readonly error?: string | null;
		}) => Effect.Effect<void>;

		readonly appendActivity: (params: {
			readonly chatSessionId: string;
			readonly turnId: string;
			readonly activityKind: string;
			readonly toolName: string | null;
			readonly summary: string;
			readonly payload?: unknown;
		}) => Effect.Effect<{ readonly id: string; readonly sequence: number }>;

		/** Read the full timeline for a session, ordered by sequence. */
		readonly listTimeline: (
			chatSessionId: string,
		) => Effect.Effect<readonly ChatTimelineEntry[]>;
	}
>() {}

const nowIso = (): string => new Date().toISOString();

export const ChatSessionServiceLive = Layer.effect(
	ChatSessionService,
	Effect.gen(function* () {
		const { db } = yield* DbService;

		// Atomically allocate the next sequence number for a session. Wrapped
		// in a transaction so two concurrent turns (which shouldn't happen for
		// the same PR, but might during retries) can't double-issue the same
		// number — the unique index would catch it but a transaction is cheaper.
		const allocateSequence = (chatSessionId: string): number =>
			db.transaction((tx) => {
				const row = tx
					.select({ next: chatSessions.nextSequence })
					.from(chatSessions)
					.where(eq(chatSessions.id, chatSessionId))
					.get();
				if (!row) {
					throw new Error(
						`chat_sessions row ${chatSessionId} disappeared during sequence allocation`,
					);
				}
				const seq = row.next;
				tx
					.update(chatSessions)
					.set({ nextSequence: seq + 1, lastActivityAt: nowIso() })
					.where(eq(chatSessions.id, chatSessionId))
					.run();
				return seq;
			});

		const rowToSessionRow = (
			row: typeof chatSessions.$inferSelect,
		): ChatSessionRow => ({
			id: row.id,
			pullRequestId: row.pullRequestId,
			agent: row.agent,
			sessionId: row.sessionId,
			prHeadSha: row.prHeadSha,
			worktreePath: row.worktreePath,
			branchName: row.branchName,
			nextSequence: row.nextSequence,
			createdAt: row.createdAt,
			lastActivityAt: row.lastActivityAt,
		});

		return {
			find: (prId, agent, prHeadSha) =>
				Effect.sync(() => {
					const row = db
						.select()
						.from(chatSessions)
						.where(
							and(
								eq(chatSessions.pullRequestId, prId),
								eq(chatSessions.agent, agent),
								eq(chatSessions.prHeadSha, prHeadSha),
							),
						)
						.get();
					return row ? rowToSessionRow(row) : null;
				}),

			findOrCreate: ({ prId, agent, prHeadSha, worktreePath, branchName }) =>
				Effect.sync(() => {
					const existing = db
						.select()
						.from(chatSessions)
						.where(
							and(
								eq(chatSessions.pullRequestId, prId),
								eq(chatSessions.agent, agent),
								eq(chatSessions.prHeadSha, prHeadSha),
							),
						)
						.get();
					if (existing) {
						// Refresh worktree/branch in case the PR's worktree was
						// reseated to a new path. Cheap.
						if (
							existing.worktreePath !== worktreePath ||
							existing.branchName !== branchName
						) {
							db
								.update(chatSessions)
								.set({ worktreePath, branchName, lastActivityAt: nowIso() })
								.where(eq(chatSessions.id, existing.id))
								.run();
							existing.worktreePath = worktreePath;
							existing.branchName = branchName;
						}
						return rowToSessionRow(existing);
					}
					const id = crypto.randomUUID();
					const now = nowIso();
					db
						.insert(chatSessions)
						.values({
							id,
							pullRequestId: prId,
							agent,
							sessionId: null,
							prHeadSha,
							worktreePath,
							branchName,
							nextSequence: 0,
							createdAt: now,
							lastActivityAt: now,
						})
						.run();
					return {
						id,
						pullRequestId: prId,
						agent,
						sessionId: null,
						prHeadSha,
						worktreePath,
						branchName,
						nextSequence: 0,
						createdAt: now,
						lastActivityAt: now,
					};
				}),

			setAgentSessionId: ({ chatSessionId, sessionId, worktreePath, branchName }) =>
				Effect.sync(() => {
					db
						.update(chatSessions)
						.set({
							sessionId,
							worktreePath,
							branchName,
							lastActivityAt: nowIso(),
						})
						.where(eq(chatSessions.id, chatSessionId))
						.run();
				}),

			updatePrHeadSha: ({ chatSessionId, prHeadSha }) =>
				Effect.sync(() => {
					db
						.update(chatSessions)
						.set({ prHeadSha, lastActivityAt: nowIso() })
						.where(eq(chatSessions.id, chatSessionId))
						.run();
				}),

			upsert: ({ prId, agent, prHeadSha, sessionId, worktreePath, branchName }) =>
				Effect.sync(() => {
					const now = nowIso();
					db.insert(chatSessions)
						.values({
							id: crypto.randomUUID(),
							pullRequestId: prId,
							agent,
							sessionId,
							prHeadSha,
							worktreePath,
							branchName,
							nextSequence: 0,
							createdAt: now,
							lastActivityAt: now,
						})
						.onConflictDoUpdate({
							target: [
								chatSessions.pullRequestId,
								chatSessions.agent,
								chatSessions.prHeadSha,
							],
							set: {
								sessionId,
								worktreePath,
								branchName,
								lastActivityAt: now,
							},
						})
						.run();
				}),

			clear: (prId, agent, prHeadSha) =>
				Effect.sync(() => {
					db.delete(chatSessions)
						.where(
							and(
								eq(chatSessions.pullRequestId, prId),
								eq(chatSessions.agent, agent),
								eq(chatSessions.prHeadSha, prHeadSha),
							),
						)
						.run();
				}),

			clearAllForPr: (prId, agent) =>
				Effect.sync(() => {
					db.delete(chatSessions)
						.where(
							and(
								eq(chatSessions.pullRequestId, prId),
								eq(chatSessions.agent, agent),
							),
						)
						.run();
				}),

			clearAllForAgent: (agent) =>
				Effect.sync(() => {
					db.delete(chatSessions)
						.where(eq(chatSessions.agent, agent))
						.run();
				}),

			appendUserMessage: ({ chatSessionId, turnId, content }) =>
				Effect.sync(() => {
					const sequence = allocateSequence(chatSessionId);
					const id = crypto.randomUUID();
					const now = nowIso();
					db
						.insert(chatMessages)
						.values({
							id,
							chatSessionId,
							role: "user",
							content,
							isStreaming: 0,
							sequence,
							turnId,
							error: null,
							createdAt: now,
							finalizedAt: now,
						})
						.run();
					return { id, sequence };
				}),

			beginAssistantMessage: ({ chatSessionId, turnId }) =>
				Effect.sync(() => {
					const sequence = allocateSequence(chatSessionId);
					const id = crypto.randomUUID();
					const now = nowIso();
					db
						.insert(chatMessages)
						.values({
							id,
							chatSessionId,
							role: "assistant",
							content: "",
							isStreaming: 1,
							sequence,
							turnId,
							error: null,
							createdAt: now,
							finalizedAt: null,
						})
						.run();
					return { id, sequence };
				}),

			appendAssistantContent: ({ messageId, chunk }) =>
				Effect.sync(() => {
					if (chunk.length === 0) return;
					// SQL `||` concat — atomic and cheap. Avoids a read-modify-
					// write race if two stream callbacks ever interleaved.
					db.run(
						sql`UPDATE chat_messages SET content = content || ${chunk} WHERE id = ${messageId}`,
					);
				}),

			finalizeAssistantMessage: ({ messageId, error }) =>
				Effect.sync(() => {
					db
						.update(chatMessages)
						.set({
							isStreaming: 0,
							finalizedAt: nowIso(),
							error: error ?? null,
						})
						.where(eq(chatMessages.id, messageId))
						.run();
				}),

			appendActivity: ({
				chatSessionId,
				turnId,
				activityKind,
				toolName,
				summary,
				payload,
			}) =>
				Effect.sync(() => {
					const sequence = allocateSequence(chatSessionId);
					const id = crypto.randomUUID();
					const now = nowIso();
					db
						.insert(chatActivities)
						.values({
							id,
							chatSessionId,
							turnId,
							activityKind,
							toolName: toolName ?? null,
							summary,
							payloadJson:
								payload === undefined ? null : JSON.stringify(payload),
							sequence,
							createdAt: now,
						})
						.run();
					return { id, sequence };
				}),

			listTimeline: (chatSessionId) =>
				Effect.sync(() => {
					const messages = db
						.select()
						.from(chatMessages)
						.where(eq(chatMessages.chatSessionId, chatSessionId))
						.orderBy(asc(chatMessages.sequence))
						.all();
					const activities = db
						.select()
						.from(chatActivities)
						.where(eq(chatActivities.chatSessionId, chatSessionId))
						.orderBy(asc(chatActivities.sequence))
						.all();

					const merged: ChatTimelineEntry[] = [];
					let mi = 0;
					let ai = 0;
					while (mi < messages.length || ai < activities.length) {
						const m = messages[mi];
						const a = activities[ai];
						if (m && (!a || m.sequence < a.sequence)) {
							merged.push({
								entryKind: "message",
								id: m.id,
								chatSessionId: m.chatSessionId,
								role: m.role as "user" | "assistant",
								content: m.content,
								isStreaming: m.isStreaming === 1,
								sequence: m.sequence,
								turnId: m.turnId,
								error: m.error,
								createdAt: m.createdAt,
								finalizedAt: m.finalizedAt,
							});
							mi += 1;
						} else if (a) {
							merged.push({
								entryKind: "activity",
								id: a.id,
								chatSessionId: a.chatSessionId,
								turnId: a.turnId,
								activityKind: a.activityKind,
								toolName: a.toolName,
								summary: a.summary,
								payloadJson: a.payloadJson,
								sequence: a.sequence,
								createdAt: a.createdAt,
							});
							ai += 1;
						}
					}
					return merged;
				}),
		};
	}),
);
