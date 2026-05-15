import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { walkthroughs } from "./walkthroughs";

/**
 * Semantic step — the meaningful "chapter" of a walkthrough's Phase B body.
 * A semantic step groups a small number of atomic blocks (markdown / code /
 * diff rows in `walkthrough_blocks`) into a named conceptual unit such as
 * "Token validation changes" or "Concern: race condition". This is the layer
 * the reader navigates by; atomic blocks are the evidence within a chapter.
 *
 * Written by the `add_semantic_step` MCP tool. Each call is one atomic
 * idempotent upsert keyed on `(walkthrough_id, semantic_step_index)`, so
 * retries during resume never create duplicates (doctrine invariant #3).
 *
 * Phase A → B transition is owned by this table: the very first
 * `add_semantic_step` call advances `walkthroughs.last_completed_phase`
 * from 'A' to 'B'. `add_diff_step` then requires a parent row here to
 * exist before it will accept its write.
 */
export const walkthroughSemanticSteps = sqliteTable(
  "walkthrough_semantic_steps",
  {
    id: text("id").primaryKey(),
    walkthroughId: text("walkthrough_id")
      .notNull()
      .references(() => walkthroughs.id, { onDelete: "cascade" }),
    /**
     * Monotonic, zero-based index for ordering semantic steps within a
     * walkthrough. The agent passes this explicitly so the upsert key is
     * deterministic across resumes.
     */
    semanticStepIndex: integer("semantic_step_index").notNull(),
    /** Short title — the chapter name shown in the UI. */
    title: text("title").notNull(),
    /**
     * Optional 1–2 sentence prelude rendered under the chapter title. Nullable
     * — many sections need no preface beyond their title and inner blocks.
     */
    summary: text("summary"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    /**
     * One row per (walkthroughId, semanticStepIndex). `add_semantic_step` upserts
     * on this target so a retry of the same call after a crash replays as a no-op.
     */
    semanticStepUnique: uniqueIndex("walkthrough_semantic_steps_unique").on(
      t.walkthroughId,
      t.semanticStepIndex,
    ),
  }),
);
