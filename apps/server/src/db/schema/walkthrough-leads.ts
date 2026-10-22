import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { walkthroughIssues } from "./walkthrough-issues";
import { walkthroughs } from "./walkthroughs";

/**
 * The first-pass leads one walkthrough's agent was handed, and what it made
 * of each. The orchestrator inserts the selection at job start, once
 * (invariant 2's carve-out), so a resume prompts with the same set under the
 * same ids. The verdict columns are written only by the `resolve_lead` MCP
 * tool.
 */
export const walkthroughLeads = sqliteTable(
  "walkthrough_leads",
  {
    id: text("id").primaryKey(),
    walkthroughId: text("walkthrough_id")
      .notNull()
      .references(() => walkthroughs.id, { onDelete: "cascade" }),
    /** `L1`…`Ln`, strongest first: the id the agent resolves the lead by. */
    leadKey: text("lead_key").notNull(),
    /** Position in the prompt's list, so reads keep the order the agent saw. */
    ordinal: integer("ordinal").notNull(),
    filePath: text("file_path").notNull(),
    hunkIndex: integer("hunk_index").notNull(),
    newStart: integer("new_start").notNull(),
    newLines: integer("new_lines").notNull(),
    smells: text("smells").notNull(), // JSON Array<{ smell: HunkSmell; probability: number }>
    verdict: text("verdict"), // LeadVerdict | null
    /** A confirmed lead's issue. Nulled when that issue is retracted or deleted. */
    issueId: text("issue_id").references(() => walkthroughIssues.id, { onDelete: "set null" }),
    reason: text("reason"),
    resolvedAt: text("resolved_at"),
  },
  (t) => [uniqueIndex("uq_walkthrough_leads_wt_key").on(t.walkthroughId, t.leadKey)],
);
