import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { chatSessions } from './chat-sessions';

/**
 * Sub-agent invocations within a chat turn. The parent agent delegates work
 * (Claude `Task` tool, opencode `agent` part) and the sub-agent runs in its
 * own scope, producing its own tool calls. We persist a row per invocation so
 * the UI can render a nested expandable card grouping the sub-agent's tool
 * calls under a single header.
 *
 * Correlation across providers:
 *   - Claude: tool_use { name: "Task" }.id → providerCallId. Matching
 *     tool_result completes the invocation. Nested tool_use blocks within
 *     the same turn that carry `parent_tool_use_id` matching this id are
 *     stamped with `subagent_invocation_id` on chat_activities so they nest
 *     in the UI.
 *   - Opencode: AgentPart.id → providerCallId. Tool parts whose `messageID`
 *     matches the sub-agent's own message id get stamped. Best-effort —
 *     parts that can't be correlated fall back to top-level rendering.
 *
 * Deterministic id: `${chatSessionId}::${providerCallId}` content-hashed to a
 * UUID so re-emitting the same invocation across retries/replays is an
 * idempotent upsert.
 */
export const chatSubagentInvocations = sqliteTable(
	'chat_subagent_invocations',
	{
		id: text('id').primaryKey(),
		chatSessionId: text('chat_session_id')
			.notNull()
			.references(() => chatSessions.id, { onDelete: 'cascade' }),
		parentTurnId: text('parent_turn_id').notNull(),
		providerCallId: text('provider_call_id').notNull(),
		// 'general-purpose' for Claude built-in, or the named agent from opencode
		// settings. Display-only — we don't gate behaviour on it.
		subagentType: text('subagent_type').notNull(),
		// Short human label ("Search for X across repo"). Comes from Task.input
		// .description (Claude) or the AgentPart's description (opencode).
		description: text('description').notNull(),
		// Full prompt handed to the sub-agent. Kept in case the UI wants to
		// reveal it on demand or for parity debugging.
		prompt: text('prompt').notNull(),
		// 'running' | 'completed' | 'errored'
		status: text('status').notNull().default('running'),
		// Final result text. Claude: from the matching tool_result block's
		// `content`. Opencode: final assistant text from the sub-agent's
		// message (best-effort). Nullable while running.
		result: text('result'),
		// 'claude' | 'opencode'
		source: text('source').notNull(),
		sequence: integer('sequence').notNull(),
		startedAt: text('started_at').notNull(),
		completedAt: text('completed_at'),
	},
	(t) => ({
		sessionCallUnique: uniqueIndex(
			'chat_subagent_invocations_session_call_unique',
		).on(t.chatSessionId, t.providerCallId),
		sessionSeqUnique: uniqueIndex(
			'chat_subagent_invocations_session_seq_unique',
		).on(t.chatSessionId, t.sequence),
		sessionIdx: index('chat_subagent_invocations_session_idx').on(
			t.chatSessionId,
		),
	}),
);
