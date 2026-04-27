// ── ChatSession ────────────────────────────────────────────────────────────
//
// Drizzle wrapper around the `chat_sessions` table. The right-pane chat
// route uses this to:
//
//   - find an existing agent session for (prId, agent, prHeadSha) so the
//     follow-up turn resumes instead of starting fresh
//   - upsert a row the first time the agent emits its session id
//   - clear a row + return the worktree handle so the route can release it
//   - locate stale-sibling rows (different prHeadSha) so we GC the old
//     worktree+branch when a new commit lands
//
// Not a doctrine-bound jobs table — see schema/chat-sessions.ts for the
// reasoning.

import { Context, Effect, Layer } from "effect";
import { and, eq, ne } from "drizzle-orm";
import { DbService } from "./Db";
import { chatSessions } from "../db/schema/index";

export interface ChatSessionRow {
	readonly id: string;
	readonly pullRequestId: string;
	readonly agent: string;
	readonly sessionId: string;
	readonly prHeadSha: string;
	readonly worktreePath: string;
	readonly branchName: string;
	readonly createdAt: string;
	readonly lastActivityAt: string;
}

export interface UpsertChatSessionParams {
	readonly prId: string;
	readonly agent: string;
	readonly prHeadSha: string;
	readonly sessionId: string;
	readonly worktreePath: string;
	readonly branchName: string;
}

export class ChatSessionService extends Context.Tag("ChatSessionService")<
	ChatSessionService,
	{
		readonly find: (
			prId: string,
			agent: string,
			prHeadSha: string,
		) => Effect.Effect<ChatSessionRow | null>;
		readonly upsert: (
			params: UpsertChatSessionParams,
		) => Effect.Effect<void>;
		readonly clear: (
			prId: string,
			agent: string,
			prHeadSha: string,
		) => Effect.Effect<{
			readonly worktreePath: string;
			readonly branchName: string;
		} | null>;
		/** Returns any row for (prId, agent) at a different prHeadSha. */
		readonly findStaleSibling: (
			prId: string,
			agent: string,
			prHeadSha: string,
		) => Effect.Effect<ChatSessionRow | null>;
		/**
		 * Delete every row for (prId, agent) regardless of prHeadSha.
		 * Returns the worktree paths so the caller can release them.
		 * Used by the DELETE /api/chat/:prId handler when the user clears
		 * the conversation from the chat header.
		 */
		readonly clearAllForPr: (
			prId: string,
			agent: string,
		) => Effect.Effect<
			ReadonlyArray<{
				readonly worktreePath: string;
				readonly branchName: string;
			}>
		>;
	}
>() {}

export const ChatSessionServiceLive = Layer.effect(
	ChatSessionService,
	Effect.gen(function* () {
		const { db } = yield* DbService;

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
					return (row as ChatSessionRow | undefined) ?? null;
				}),

			upsert: ({ prId, agent, prHeadSha, sessionId, worktreePath, branchName }) =>
				Effect.sync(() => {
					const now = new Date().toISOString();
					// Insert-or-update on the unique key. SQLite's
					// `onConflictDoUpdate` lets us refresh `sessionId` (in case the
					// agent rotated the session) and `lastActivityAt` in one go.
					db.insert(chatSessions)
						.values({
							id: crypto.randomUUID(),
							pullRequestId: prId,
							agent,
							sessionId,
							prHeadSha,
							worktreePath,
							branchName,
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
					if (!row) return null;
					db.delete(chatSessions)
						.where(eq(chatSessions.id, row.id))
						.run();
					return {
						worktreePath: row.worktreePath,
						branchName: row.branchName,
					};
				}),

			findStaleSibling: (prId, agent, prHeadSha) =>
				Effect.sync(() => {
					const row = db
						.select()
						.from(chatSessions)
						.where(
							and(
								eq(chatSessions.pullRequestId, prId),
								eq(chatSessions.agent, agent),
								ne(chatSessions.prHeadSha, prHeadSha),
							),
						)
						.get();
					return (row as ChatSessionRow | undefined) ?? null;
				}),

			clearAllForPr: (prId, agent) =>
				Effect.sync(() => {
					const rows = db
						.select()
						.from(chatSessions)
						.where(
							and(
								eq(chatSessions.pullRequestId, prId),
								eq(chatSessions.agent, agent),
							),
						)
						.all();
					if (rows.length === 0) return [];
					db.delete(chatSessions)
						.where(
							and(
								eq(chatSessions.pullRequestId, prId),
								eq(chatSessions.agent, agent),
							),
						)
						.run();
					return rows.map((r) => ({
						worktreePath: r.worktreePath,
						branchName: r.branchName,
					}));
				}),
		};
	}),
);
