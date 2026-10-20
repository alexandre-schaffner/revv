import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { repositories } from "./repositories";

/**
 * The whole-stack overview: the arc of a GitHub PR stack, each layer's role,
 * and the order to review it in. One row per stack version — `signature` is
 * a hash of the ordered open layers' `number@headSha` — so a push to any
 * layer leaves the old brief standing (marked stale by the reader) until a
 * new one supersedes it.
 *
 * Content arrives only through the stack-brief MCP tools: `set_layer_role`
 * (phase `L`, one upsert per layer) then `set_arc` (phase `R`, requires every
 * layer), then `complete_stack_brief` validates and the orchestrator
 * (`StackBriefJobs`) flips `status`. Agents never write `status` or
 * `last_completed_phase`, mirroring the walkthrough and recap pipelines.
 */
export const stackBriefs = sqliteTable(
  "stack_briefs",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    stackNumber: integer("stack_number").notNull(),
    signature: text("signature").notNull(),
    /**
     * The stack the agent was handed (JSON: base ref plus the layers' number,
     * title, head and status), captured at job start so a resume briefs the
     * same stack.
     */
    stackSnapshot: text("stack_snapshot").notNull(),
    /** Orchestrator-only: `generating | complete | error | superseded`. */
    status: text("status").notNull().default("generating"),
    /** Tool side effect only: `none | L | R`. */
    lastCompletedPhase: text("last_completed_phase").notNull().default("none"),
    arc: text("arc").notNull().default(""),
    /** JSON PR numbers in the recommended review order. */
    reviewOrder: text("review_order").notNull().default("[]"),
    resumeAttempts: integer("resume_attempts").notNull().default(0),
    supersededBy: text("superseded_by").references((): AnySQLiteColumn => stackBriefs.id, {
      onDelete: "set null",
    }),
    errorMessage: text("error_message"),
    modelUsed: text("model_used"),
    /** The user whose agent settings and token run the job. */
    userId: text("user_id").notNull(),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => [
    uniqueIndex("stack_briefs_active_signature_unique")
      .on(t.repositoryId, t.stackNumber, t.signature)
      .where(sql`${t.status} <> 'superseded'`),
    index("stack_briefs_stack_idx").on(t.repositoryId, t.stackNumber),
  ],
);

/** One layer's line in a brief, keyed on `(brief, position)`. */
export const stackBriefLayers = sqliteTable(
  "stack_brief_layers",
  {
    id: text("id").primaryKey(),
    briefId: text("brief_id")
      .notNull()
      .references(() => stackBriefs.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    prNumber: integer("pr_number").notNull(),
    role: text("role").notNull(),
    reviewFocus: text("review_focus").notNull(),
    /**
     * The stack's phase this layer belongs to, 1–3 words ("Roles", "Storage").
     * Consecutive layers sharing one read as a chapter of the stack. Null for
     * rows written before chapters existed.
     */
    chapter: text("chapter"),
    /**
     * JSON `{ number, uses }[]`: the lower layers this one actually builds on,
     * and what it takes from each, in a short phrase.
     */
    buildsOn: text("builds_on").notNull().default("[]"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("stack_brief_layers_brief_position_unique").on(t.briefId, t.position)],
);
