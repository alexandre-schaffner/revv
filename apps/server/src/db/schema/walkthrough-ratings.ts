import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    walkthroughAxisUnique: uniqueIndex("walkthrough_ratings_wt_axis_unique").on(
      t.walkthroughId,
      t.axis,
    ),
  }),
);
