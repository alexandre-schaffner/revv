import type { StackBriefStatus, StackLayerLink } from "@revv/shared";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { StackBriefSnapshot } from "../../ai/providers/stack-brief-tools/spec";
import { repositories } from "./repositories";

const STACK_BRIEF_STATUSES = [
  "generating",
  "complete",
  "error",
  "superseded",
] as const satisfies readonly StackBriefStatus[];

export const stackBriefs = sqliteTable(
  "stack_briefs",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    stackNumber: integer("stack_number").notNull(),
    signature: text("signature").notNull(),
    stackSnapshot: text("stack_snapshot", { mode: "json" }).$type<StackBriefSnapshot>().notNull(),
    status: text("status", { enum: STACK_BRIEF_STATUSES }).notNull().default("generating"),
    lastCompletedPhase: text("last_completed_phase", { enum: ["none", "L", "R"] })
      .notNull()
      .default("none"),
    arc: text("arc").notNull().default(""),
    reviewOrder: text("review_order", { mode: "json" })
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'`),
    resumeAttempts: integer("resume_attempts").notNull().default(0),
    supersededBy: text("superseded_by").references((): AnySQLiteColumn => stackBriefs.id, {
      onDelete: "set null",
    }),
    errorMessage: text("error_message"),
    modelUsed: text("model_used"),
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
    chapter: text("chapter").notNull(),
    buildsOn: text("builds_on", { mode: "json" })
      .$type<StackLayerLink[]>()
      .notNull()
      .default(sql`'[]'`),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("stack_brief_layers_brief_position_unique").on(t.briefId, t.position)],
);
