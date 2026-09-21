import type { VerdictSource } from "@revv/shared";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { walkthroughs } from "./walkthroughs";

/**
 * Per-axis scorecard entries for a walkthrough. Each row is a single axis
 * verdict; the UNIQUE index prevents the model from rating the same axis
 * twice within a generation (see the `rate_axis` MCP tool).
 */
export const walkthroughRatings = sqliteTable(
  "walkthrough_ratings",
  {
    id: text("id").primaryKey(),
    walkthroughId: text("walkthrough_id")
      .notNull()
      .references(() => walkthroughs.id, { onDelete: "cascade" }),
    axis: text("axis").notNull(), // RatingAxis
    verdict: text("verdict").notNull(), // 'pass' | 'concern' | 'blocker'
    confidence: text("confidence").notNull(), // 'low' | 'medium' | 'high'
    rationale: text("rationale").notNull(),
    details: text("details").notNull().default(""),
    citations: text("citations").notNull().default("[]"), // JSON RatingCitation[]
    blockIds: text("block_ids").notNull().default("[]"), // JSON string[]
    /**
     * `'agent'` (the original contract) or `'advisory'` when the orchestrator
     * pre-assigned {@link verdict} from Jev and `rate_axis` only filled in
     * the prose. Defaulted rather than nullable so pre-existing rows read as
     * what they are.
     */
    verdictSource: text("verdict_source").$type<VerdictSource>().notNull().default("agent"),
    /** Calibrated confidence [0,1] behind an advisory verdict; null for agent verdicts. */
    verdictConfidence: real("verdict_confidence"),
    /**
     * The agent was handed a non-`pass` verdict and could find nothing to
     * cite. Recorded as the disagreement signal; never changes the verdict.
     */
    disputed: integer("disputed", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    walkthroughAxisUnique: uniqueIndex("walkthrough_ratings_wt_axis_unique").on(
      t.walkthroughId,
      t.axis,
    ),
  }),
);
