import type { CloneStatus } from "@revv/shared";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
    /** Raw owner avatar URL from the provider. On GitHub Enterprise it is signed
     *  and expires, so it is served only for github.com repos. */
    avatarUrl: text("avatar_url"),
    /** Retired: owner avatars are cached in `remote_users` (migration 0500). */
    avatarContent: text("avatar_content"),
    addedAt: text("added_at").notNull(),
    cloneStatus: text("clone_status").notNull().default("pending").$type<CloneStatus>(),
    clonePath: text("clone_path"),
    cloneError: text("clone_error"),
    managed: integer("managed", { mode: "boolean" }).notNull().default(true),
    /**
     * Revv wrote the folder at `clone_path`: set before a clone writes into it
     * (or when Revv adopts its own leftover), cleared when Revv refuses or
     * lets go of the folder. A clone cut off mid-way keeps it, so a retry
     * clears the partial clone instead of refusing it, and removing the repo
     * deletes the folder only when it is set.
     */
    revvWroteClone: integer("revv_wrote_clone", { mode: "boolean" }).notNull().default(false),
    githubHost: text("github_host").notNull().default("github.com"),
    accountId: text("account_id")
      .notNull()
      .references(() => account.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("uq_repositories_full_name_account").on(table.fullName, table.accountId)],
);
