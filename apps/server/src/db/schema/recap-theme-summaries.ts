import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projectRecaps } from "./project-recaps";

/**
 * Short editorial summary paragraph for a single theme within a recap.
 *
 * Themes are open-vocabulary lowercase labels picked per-PR by the agent on
 * `recap_pr_entries.theme`. After cataloguing the per-PR entries, the agent
 * calls `set_theme_summary` once per distinct theme it used to write a 1–2
 * sentence chapter-lede that frames what landed in that area. The UI renders
 * this paragraph under each theme heading in the recap body.
 *
 * Idempotent upsert keyed on `(recap_id, theme)` so partial-progress runs can
 * resume without producing duplicates. Theme labels are normalized the same
 * way `add_pr_entry` normalizes its `theme` argument (lowercase + trimmed +
 * single-space) so a chapter and its summary join cleanly.
 */
export const recapThemeSummaries = sqliteTable(
  "recap_theme_summaries",
  {
    id: text("id").primaryKey(),
    recapId: text("recap_id")
      .notNull()
      .references(() => projectRecaps.id, { onDelete: "cascade" }),
    /** Lowercase theme label matching `recap_pr_entries.theme` for the same recap. */
    theme: text("theme").notNull(),
    /**
     * One- or two-sentence summary of the theme's work in this period. Plain
     * prose; may contain backtick-wrapped code spans (rendered as `.codechip`
     * inline elements at render time). No other markdown.
     */
    summary: text("summary").notNull(),
  },
  (t) => ({
    /** Idempotency key — the agent upserts on this on every `set_theme_summary`. */
    recapThemeUniqueIdx: uniqueIndex("recap_theme_summaries_recap_theme_unique_idx").on(
      t.recapId,
      t.theme,
    ),
    /** Join-back-to-recap index for the read path. */
    recapIdx: index("recap_theme_summaries_recap_idx").on(t.recapId),
  }),
);
