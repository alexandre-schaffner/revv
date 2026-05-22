import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projectRecaps } from "./project-recaps";
import { pullRequests } from "./pull-requests";

/**
 * Compact, durable per-PR context for project recap generation.
 *
 * Raw diffs can be very large and cannot be removed from an LLM session once a
 * tool returns them. Recap generation therefore compacts each raw PR diff into
 * this table before the final recap agent runs. The final agent reads these
 * bounded digests instead of raw patches, so context grows with digest size
 * rather than raw diff size.
 */
export const recapPrDigests = sqliteTable(
  "recap_pr_digests",
  {
    id: text("id").primaryKey(),
    recapId: text("recap_id")
      .notNull()
      .references(() => projectRecaps.id, { onDelete: "cascade" }),
    prId: text("pr_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    /** cache | github | unavailable — mirrors RecapSourcePrDiff.source. */
    source: text("source").notNull(),
    /** Short markdown/plaintext summary handed to the final recap agent. */
    digest: text("digest").notNull(),
    /** JSON array of compact file descriptors used to produce the digest. */
    files: text("files").notNull().default("[]"),
    /** Human-readable note about truncation or unavailable data. */
    note: text("note"),
    generatedAt: text("generated_at").notNull(),
  },
  (t) => ({
    recapPrUniqueIdx: uniqueIndex("recap_pr_digests_recap_pr_unique_idx").on(t.recapId, t.prId),
    recapIdx: index("recap_pr_digests_recap_idx").on(t.recapId),
  }),
);
