import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { chatSessions } from './chat-sessions';

/**
 * Right-pane chat transcript — one row per user or assistant turn-body.
 *
 * Persists what used to live only in Svelte runes + the agent's own session
 * storage (Claude SDK JSONL, opencode daemon). With this table the transcript
 * survives desktop reloads, daemon restarts, agent-side session-storage churn,
 * and (when paired with B3 from the gap-analysis roadmap) reconnect-mid-stream.
 *
 * Lifecycle:
 *   - User message: inserted at turn start with role='user', is_streaming=0,
 *                   content=<the user's text>, finalized_at=created_at.
 *   - Assistant message: inserted lazily at first text chunk OR at turn
 *                   finalize. is_streaming=1 while the agent is mid-stream;
 *                   content is appended to in-place via SQL `||`.
 *                   On finalize: is_streaming=0, finalized_at set. On error:
 *                   `error` populated with the inline-error chip text.
 *
 * Sequence is per-session monotonic, allocated against
 * `chat_sessions.next_sequence` so it shares one ordering space with
 * `chat_activities`. This lets the UI interleave activity rows between
 * user and assistant turns without timestamp-jitter ambiguity.
 *
 * `turn_id` groups (user_message, assistant_message, activities) for the same
 * user→agent exchange. Used today only for foreign-key style grouping; will
 * become load-bearing for E1 (turn-level revert / checkpoint diffs).
 */
export const chatMessages = sqliteTable(
	'chat_messages',
	{
		id: text('id').primaryKey(),
		chatSessionId: text('chat_session_id')
			.notNull()
			.references(() => chatSessions.id, { onDelete: 'cascade' }),
		role: text('role').notNull(), // 'user' | 'assistant'
		content: text('content').notNull().default(''),
		isStreaming: integer('is_streaming').notNull().default(0),
		sequence: integer('sequence').notNull(),
		turnId: text('turn_id').notNull(),
		error: text('error'),
		createdAt: text('created_at').notNull(),
		finalizedAt: text('finalized_at'),
	},
	(t) => ({
		sessionSeqUnique: uniqueIndex('chat_messages_session_seq_unique').on(
			t.chatSessionId,
			t.sequence,
		),
		sessionIdx: index('chat_messages_session_idx').on(t.chatSessionId),
	}),
);
