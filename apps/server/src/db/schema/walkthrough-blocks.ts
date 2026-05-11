import { integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import { walkthroughs } from './walkthroughs';

/**
 * A single atomic content block in a walkthrough. Blocks are an ordered stream
 * produced during Phase B of the 4-phase pipeline (see "Agent Subsystem
 * Invariants" in the root CLAUDE.md).
 *
 * Every Phase B diff step is exactly one block with `phase = 'diff_analysis'`,
 * a non-null `semanticStepIndex` linking it to a row in
 * `walkthrough_semantic_steps`, and a non-null `stepIndex` for ordering within
 * that semantic step (resets to 0 in each section).
 *
 * The `(walkthrough_id, phase, semantic_step_index, step_index)` unique index
 * makes `add_diff_step` idempotent: a retry with the same identity replays
 * as an `onConflictDoUpdate` no-op rather than duplicating the row.
 */
export const walkthroughBlocks = sqliteTable(
	'walkthrough_blocks',
	{
		id: text('id').primaryKey(),
		walkthroughId: text('walkthrough_id')
			.notNull()
			.references(() => walkthroughs.id, { onDelete: 'cascade' }),
		/** Phase this block belongs to. Currently only `'diff_analysis'` is populated. */
		phase: text('phase').notNull().default('diff_analysis'),
		/**
		 * Foreign-key-style pointer to the parent `walkthrough_semantic_steps`
		 * row (composite key (walkthroughId, semanticStepIndex)). Required for
		 * `phase = 'diff_analysis'` blocks. The reference is not declared as a
		 * SQL FK because the parent table's identity is composite — we rely on
		 * application-level validation in `add_diff_step` instead.
		 */
		semanticStepIndex: integer('semantic_step_index').notNull(),
		/**
		 * Global sort order across all blocks in a walkthrough.
		 * Computed as `semanticStepIndex * 10000 + stepIndex` so blocks sort
		 * deterministically without a separate sequence table.
		 */
		order: integer('order').notNull(),
		/**
		 * Position of this atomic block *within* its parent semantic step.
		 * Monotonic, zero-based, resets in each semantic step. Sort order across
		 * the walkthrough is `(semanticStepIndex, stepIndex)`.
		 */
		stepIndex: integer('step_index').notNull(),
		type: text('type').notNull(),
		data: text('data').notNull(), // JSON of the full WalkthroughBlock
		createdAt: text('created_at').notNull(),
	},
	(t) => ({
		/**
		 * One row per (walkthroughId, phase, semanticStepIndex, stepIndex). Phase B
		 * idempotency relies on this: `add_diff_step` is an `onConflictDoUpdate`
		 * on this target, so retries never duplicate rows.
		 */
		phaseStepUnique: uniqueIndex(
			'walkthrough_blocks_phase_step_unique',
		).on(t.walkthroughId, t.phase, t.semanticStepIndex, t.stepIndex),
	}),
);
