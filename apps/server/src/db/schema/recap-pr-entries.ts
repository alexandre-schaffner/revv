import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projectRecaps } from "./project-recaps";

/**
 * Structured per-PR row inside a project recap. One entry per PR the agent
 * decided to include in the recap narrative (chore/typo PRs may be skipped by
 * editorial discretion). Written by the `add_pr_entry` MCP tool as an
 * idempotent upsert keyed on `(recapId, prId)` so partial-progress runs can
 * resume without producing duplicates.
 *
 * `prId` is a free text reference rather than a hard FK to `pull_requests`:
 * the recap should outlive PR garbage collection. At render time the UI joins
 * back to the current PR row for live title/url, falling back to the values
 * embedded here if the PR has been pruned.
 *
 * `theme` is an open-vocabulary lowercase label (e.g. `auth`, `payments`,
 * `frontend`) — the agent picks one per PR. The UI deterministically maps
 * theme name → swatch color via a hash, and orders chapters by entry count
 * desc (ties broken alphabetically). There is no fixed taxonomy; that
 * decision intentionally departs from the original draft, which hardcoded
 * five Revv-specific themes that don't generalize across repos.
 */
export const recapPrEntries = sqliteTable(
  "recap_pr_entries",
  {
    id: text("id").primaryKey(),
    recapId: text("recap_id")
      .notNull()
      .references(() => projectRecaps.id, { onDelete: "cascade" }),
    /**
     * PR identity. Soft reference — not a FK to `pull_requests` so the recap
     * survives PR pruning. See file header.
     */
    prId: text("pr_id").notNull(),
    /** Render order within the recap; preserved from the agent's call sequence. */
    position: integer("position").notNull(),
    /** Short lowercase theme label, agent-chosen (open vocabulary). */
    theme: text("theme").notNull(),
    /** Past-tense verb: `shipped`, `fixed`, `refactored`, `removed`, etc. */
    verb: text("verb").notNull(),
    /**
     * Denormalized PR title at recap time. Snapshotted on insert so the
     * recap renders even after the PR row is pruned. Falls back to "(PR
     * removed)" at render time if somehow null.
     */
    prTitle: text("pr_title").notNull().default(""),
    /** Denormalized GitHub PR number at recap time (the externalId). */
    prExternalId: integer("pr_external_id").notNull().default(0),
    /** Denormalized author github login at recap time. */
    prAuthorLogin: text("pr_author_login").notNull().default(""),
    /**
     * One-sentence description. May contain backtick-wrapped code spans which
     * the UI renders as `.codechip` inline elements. No other markdown.
     */
    description: text("description").notNull(),
    /** Additions for this PR (mirrors `pull_requests.additions` at recap time). */
    linesAdded: integer("lines_added").notNull().default(0),
    /** Deletions for this PR. */
    linesRemoved: integer("lines_removed").notNull().default(0),
    /**
     * Whether the PR was archived (merged/closed) at recap time or still
     * open. Server-derived in `add_pr_entry` from which source-bundle list the
     * `pr_id` appeared in (`sourceBundle.prs` → `'merged'`,
     * `sourceBundle.openPrs` → `'open'`). The UI renders open entries as an
     * "In progress" subgroup inside the theme chapter. Default `'merged'` for
     * back-compat on rows written before this column existed.
     */
    prState: text("pr_state", { enum: ["merged", "open"] })
      .notNull()
      .default("merged"),
  },
  (t) => ({
    /** Idempotency key — the agent upserts on this on every `add_pr_entry`. */
    recapPrUniqueIdx: uniqueIndex("recap_pr_entries_recap_pr_unique_idx").on(t.recapId, t.prId),
    /** Render-order index for the join-and-order-by-position read path. */
    recapPositionIdx: index("recap_pr_entries_recap_position_idx").on(t.recapId, t.position),
  }),
);
