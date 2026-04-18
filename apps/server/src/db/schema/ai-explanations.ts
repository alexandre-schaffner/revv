import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Durable cache for AI code explanations.
 *
 * The cache key is the combination of (prId, headSha, filePath, rangeStart,
 * rangeEnd, snippetHash, model). All fields together form a logical unique
 * index; `id` is a surrogate key for foreign-key ergonomics if needed.
 *
 * `headSha` pins the entry to a specific commit so explanation content stays
 * valid even after the PR is force-pushed. The row is simply not matched on
 * the new SHA — callers naturally fall through to the AI on a cache miss.
 *
 * `snippetHash` is the SHA-256 hex digest of the `codeSnippet` parameter so
 * minor whitespace changes in the editor don't reuse wrong explanations.
 */
export const aiExplanations = sqliteTable(
	'ai_explanations',
	{
		id: text('id').primaryKey(),
		prId: text('pr_id').notNull(),
		headSha: text('head_sha').notNull(),
		filePath: text('file_path').notNull(),
		rangeStart: integer('range_start').notNull(),
		rangeEnd: integer('range_end').notNull(),
		snippetHash: text('snippet_hash').notNull(),
		model: text('model').notNull(),
		/** Full streamed response, concatenated. */
		content: text('content').notNull(),
		/** JSON blob matching AI token-usage shape. */
		tokenUsage: text('token_usage').notNull().default('{}'),
		fetchedAt: text('fetched_at').notNull(),
	},
	(table) => [
		uniqueIndex('ai_explanations_key_idx').on(
			table.prId,
			table.headSha,
			table.filePath,
			table.rangeStart,
			table.rangeEnd,
			table.snippetHash,
			table.model,
		),
	],
);
