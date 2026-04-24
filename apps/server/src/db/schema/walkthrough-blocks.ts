import { integer, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sqliteTable } from 'drizzle-orm/sqlite-core';
import { walkthroughs } from './walkthroughs';

/**
 * A single content block in a walkthrough. Blocks are an ordered stream
 * produced during Phase B of the 4-phase pipeline (see
 * "Agent Subsystem Invariants" in the root CLAUDE.md).
 *
 * Every Phase B diff step is exactly one block with `phase = 'diff_analysis'`
 * and a non-null `stepIndex` for deterministic idempotency. Phase A overview
 * lives on `walkthroughs.summary`; Phase C sentiment lives on
 * `walkthroughs.sentiment` — they do not produce `walkthrough_blocks` rows.
 *
 * The `(walkthrough_id, phase, step_index)` unique index enforces one row per
 * step in Phase B. `onConflictDoUpdate` on that target makes `add_diff_step`
 * replays idempotent no-ops.
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
		 * Step index within Phase B — monotonic, zero-based, deterministic. The
		 * agent is instructed to pass this explicitly so resume is idempotent.
		 * Null for non-Phase-B blocks (if any future phases produce blocks).
		 */
		stepIndex: integer('step_index'),
		/** Retained for render ordering and legacy compatibility. Equals `stepIndex` for diff_analysis blocks. */
		order: integer('order').notNull(),
		type: text('type').notNull(),
		data: text('data').notNull(), // JSON of the full WalkthroughBlock
		createdAt: text('created_at').notNull(),
	},
	(t) => ({
		/**
		 * One row per (walkthroughId, phase, stepIndex). Phase B idempotency
		 * relies on this: `add_diff_step` is an `onConflictDoUpdate` on this
		 * target, so retries never duplicate rows.
		 */
		phaseStepUnique: uniqueIndex(
			'walkthrough_blocks_phase_step_unique',
		).on(t.walkthroughId, t.phase, t.stepIndex),
	}),
);
