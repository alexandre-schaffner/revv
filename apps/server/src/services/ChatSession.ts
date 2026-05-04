// ── ChatSession ────────────────────────────────────────────────────────────
//
// Drizzle wrapper around the `chat_sessions` table. The right-pane chat
// route uses this to:
//
//   - find an existing agent session for (prId, agent, prHeadSha) so the
//     follow-up turn resumes instead of starting fresh
//   - upsert a row the first time the agent emits its session id
//   - clear rows when the user resets the conversation
//
// The `worktreePath` / `branchName` columns are now informational — every
// session for a given PR resolves to the same per-PR worktree at
// `worktrees/pr-{prNumber}`, refreshed in place by `acquirePrWorktree`. We
// still record them per row so the proposed-changes endpoint can read
// commits without re-resolving the path on every request.
//
// Not a doctrine-bound jobs table — see schema/chat-sessions.ts for the
// reasoning.

import { Context, Effect, Layer } from "effect";
import { and, eq } from "drizzle-orm";
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
		) => Effect.Effect<void>;
		/**
		 * Delete every row for (prId, agent) regardless of prHeadSha. Used by
		 * the DELETE /api/chat/:prId handler when the user clears the
		 * conversation from the chat header. The per-PR worktree itself is
		 * not torn down — it's shared with walkthrough generation.
		 */
		readonly clearAllForPr: (
			prId: string,
			agent: string,
		) => Effect.Effect<void>;
		/**
		 * Delete every row for `agent` across all PRs. Called when the
		 * agent's underlying process dies and any stored session ids become
		 * orphaned (opencode daemon restart — invariant #14: daemon
		 * credentials and bound state are ephemeral). The next chat turn
		 * for any PR creates a fresh session with the system prompt
		 * re-attached.
		 */
		readonly clearAllForAgent: (agent: string) => Effect.Effect<void>;
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
		};
	}),
);
