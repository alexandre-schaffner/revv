import type { CloneStatus } from "@revv/shared";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { serverEnv } from "../../config";
import { account } from "./auth";

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
    cloneStatus: text("clone_status").notNull().default("pending").$type<CloneStatus>(),
    clonePath: text("clone_path"),
    cloneError: text("clone_error"),
    managed: integer("managed", { mode: "boolean" }).notNull().default(true),
    githubHost: text("github_host").notNull().default(serverEnv.githubHost),
    accountId: text("account_id")
      .notNull()
      .references(() => account.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("uq_repositories_full_name_account").on(table.fullName, table.accountId)],
);
