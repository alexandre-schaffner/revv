import type { CloneStatus } from "@revv/shared";
import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const repositories = sqliteTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull().default("github"),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    avatarUrl: text("avatar_url"),
    addedAt: text("added_at").notNull(),
    cloneStatus: text("clone_status")
      .notNull()
      .default("pending")
      .$type<CloneStatus>(),
    clonePath: text("clone_path"),
    cloneError: text("clone_error"),
  },
  (table) => [uniqueIndex("uq_repositories_full_name").on(table.fullName)],
);
