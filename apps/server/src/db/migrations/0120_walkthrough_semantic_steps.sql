-- Walkthrough semantic steps — two-level structure for Phase B bodies.
--
-- See "Agent Subsystem Invariants" in CLAUDE.md. Phase B used to be a flat
-- stream of atomic markdown / code / diff rows in `walkthrough_blocks`. The
-- model produced 12–25 atomic rows for what was meant (per PRD-03) to feel
-- like 3–8 conceptual chapters. This migration adds a `walkthrough_semantic_steps`
-- table that names each chapter, and a `semantic_step_index` column on
-- `walkthrough_blocks` linking each atomic row to its parent chapter.
--
-- Schema additions:
--   1. `walkthrough_semantic_steps` — one row per chapter, keyed on
--      `(walkthrough_id, semantic_step_index)`. Written by the new
--      `add_semantic_step` MCP tool. The first call advances the pipeline
--      pointer from Phase A to Phase B.
--   2. `walkthrough_blocks.semantic_step_index` — NOT NULL pointer to the
--      parent chapter. Existing rows are backfilled to a single "Diff
--      analysis" chapter (index 0) so legacy walkthroughs keep rendering.
--   3. Unique index swap: the old
--      `(walkthrough_id, phase, step_index)` is replaced by
--      `(walkthrough_id, phase, semantic_step_index, step_index)`. Step
--      indices are now per-chapter; the same `step_index = 0` is valid
--      across multiple chapters within the same walkthrough.
--
-- Backfill strategy:
--   - Every walkthrough with at least one block gets a synthetic semantic
--     step at index 0, title "Diff analysis". This preserves rendering for
--     legacy `complete` rows.
--   - Existing block rows get `semantic_step_index = 0` (column default).
--   - Rows with NULL `step_index` (legacy non-Phase-B writes — should be
--     empty) get `step_index = "order"` as a defensive fallback so the
--     unique index can be created.
--   - The legacy `order` column is kept on `walkthrough_blocks` (Drizzle's
--     TS schema no longer references it, but leaving the column avoids a
--     full table rebuild). Reads sort by (semantic_step_index, step_index).

CREATE TABLE `walkthrough_semantic_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`walkthrough_id` text NOT NULL,
	`semantic_step_index` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`walkthrough_id`) REFERENCES `walkthroughs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `walkthrough_semantic_steps_unique`
	ON `walkthrough_semantic_steps` (`walkthrough_id`, `semantic_step_index`);
--> statement-breakpoint

-- Add `semantic_step_index` with a default 0 so existing rows satisfy
-- NOT NULL on backfill. New writes will always pass an explicit value.
ALTER TABLE `walkthrough_blocks` ADD COLUMN `semantic_step_index` integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Backfill step_index for any legacy row that has NULL step_index. The
-- composite unique index below requires non-NULL values across the key.
UPDATE `walkthrough_blocks`
SET `step_index` = COALESCE(`step_index`, `order`)
WHERE `step_index` IS NULL;
--> statement-breakpoint

-- For every walkthrough that has at least one diff-analysis block but no
-- semantic-step rows yet, insert a synthetic chapter at index 0 titled
-- "Diff analysis". Existing block rows already carry semantic_step_index=0
-- (column default), so the FK-style link is automatic.
INSERT INTO `walkthrough_semantic_steps`
	(`id`, `walkthrough_id`, `semantic_step_index`, `title`, `summary`, `created_at`)
SELECT
	'semantic-' || w.`id` || '-0',
	w.`id`,
	0,
	'Diff analysis',
	NULL,
	COALESCE(w.`generated_at`, datetime('now'))
FROM `walkthroughs` AS w
WHERE EXISTS (
	SELECT 1 FROM `walkthrough_blocks` AS b
	WHERE b.`walkthrough_id` = w.`id`
	  AND b.`phase` = 'diff_analysis'
)
AND NOT EXISTS (
	SELECT 1 FROM `walkthrough_semantic_steps` AS s
	WHERE s.`walkthrough_id` = w.`id`
);
--> statement-breakpoint

-- Swap the unique index. The old shape can't coexist with the new one
-- (the same step_index will repeat across chapters), so we drop first.
DROP INDEX IF EXISTS `walkthrough_blocks_phase_step_unique`;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `walkthrough_blocks_phase_step_unique`
	ON `walkthrough_blocks` (`walkthrough_id`, `phase`, `semantic_step_index`, `step_index`);
