import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { chatSessions } from './chat-sessions';

/**
 * Right-pane chat tool-use rows. The structured replacement for the opaque
 * `{kind: 'tool', data: string}` SSE frame the previous design forwarded.
 *
 * Each row is one tool invocation surfaced to the user (Read, Grep, Bash,
 * Edit, Write, MCP context lookups, etc.). The provider drivers classify the
 * raw tool name into a controlled `activity_kind` so the UI can pick a typed
 * icon + style and so future approval flows (gap C2) can attach without a
 * schema change. The raw provider tool name is preserved in `tool_name` for
 * debugging / parity verification across drivers.
 *
 * Sequence shares the per-session monotonic space with `chat_messages` so a
 * single ORDER BY sequence reconstructs the timeline.
 *
 * `payload_json` is best-effort: the Claude Agent SDK exposes the raw tool
 * input so we capture it; opencode emits structured tool events but we
 * currently only translate into a description string, so payload may be null.
 * Future work (F1: canonical ProviderRuntimeEvent) standardises this.
 */
export const chatActivities = sqliteTable(
	'chat_activities',
	{
		id: text('id').primaryKey(),
		chatSessionId: text('chat_session_id')
			.notNull()
			.references(() => chatSessions.id, { onDelete: 'cascade' }),
		turnId: text('turn_id').notNull(),
		// Controlled vocabulary: 'tool.read' | 'tool.grep' | 'tool.glob' |
		// 'tool.ls' | 'tool.bash' | 'tool.write' | 'tool.edit' |
		// 'tool.todo' | 'tool.mcp' | 'tool.other'.
		activityKind: text('activity_kind').notNull(),
		toolName: text('tool_name'),
		summary: text('summary').notNull(),
		payloadJson: text('payload_json'),
		sequence: integer('sequence').notNull(),
		createdAt: text('created_at').notNull(),
	},
	(t) => ({
		sessionSeqUnique: uniqueIndex('chat_activities_session_seq_unique').on(
			t.chatSessionId,
			t.sequence,
		),
		sessionIdx: index('chat_activities_session_idx').on(t.chatSessionId),
	}),
);
