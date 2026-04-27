import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { pullRequests } from './pull-requests';

/**
 * Persistent mapping for the right-pane AI chat session.
 *
 * Each row is the durable handle for a live agent conversation scoped to
 * `(pullRequestId, agent, prHeadSha)`:
 *   - `sessionId`     — the agent-side session UUID. For the Claude Agent SDK
 *                       this is the UUID under `~/.claude/projects/<dir>/`;
 *                       for opencode it's the daemon's session id.
 *   - `worktreePath`  — absolute path to the chat worktree (`chat-{prId}-{sha12}`)
 *                       checked out at `prHeadSha`. The agent's `cwd`.
 *   - `branchName`    — the working branch (`revv-chat/{prId}-{sha12}`) the
 *                       agent commits its proposed changes to.
 *
 * A new commit on the PR ⇒ different `prHeadSha` ⇒ new row, new agent
 * session, fresh worktree on a fresh branch. The unique index makes the
 * orchestrator's upsert in the chat route naturally idempotent.
 *
 * NOT a doctrine-bound jobs table (CLAUDE.md "Agent Subsystem Invariants"):
 * the only durable artefacts are this row plus the agent's own session
 * persistence and the on-disk git worktree. Writes are confined to the
 * worktree (a reconstructible cache); `kill -9` mid-edit at worst loses an
 * uncommitted edit, which is acceptable for an in-progress AI suggestion.
 */
export const chatSessions = sqliteTable(
	'chat_sessions',
	{
		id: text('id').primaryKey(),
		pullRequestId: text('pull_request_id')
			.notNull()
			.references(() => pullRequests.id, { onDelete: 'cascade' }),
		agent: text('agent').notNull(), // 'claude' | 'opencode'
		sessionId: text('session_id').notNull(),
		prHeadSha: text('pr_head_sha').notNull(),
		worktreePath: text('worktree_path').notNull(),
		branchName: text('branch_name').notNull(),
		createdAt: text('created_at').notNull(),
		lastActivityAt: text('last_activity_at').notNull(),
	},
	(t) => ({
		prAgentShaUnique: uniqueIndex('chat_sessions_pr_agent_sha_unique').on(
			t.pullRequestId,
			t.agent,
			t.prHeadSha,
		),
	}),
);
