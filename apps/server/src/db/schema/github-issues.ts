import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { repositories } from "./repositories";

export const githubIssues = sqliteTable(
  "github_issues",
  {
    id: text("id").primaryKey(),
    externalId: integer("external_id").notNull(),
    nodeId: text("node_id").notNull(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body"),
    state: text("state").notNull().default("open"),
    authorLogin: text("author_login").notNull(),
    authorAvatarUrl: text("author_avatar_url"),
    assigneeLogins: text("assignee_logins").notNull().default("[]"),
    commentCount: integer("comment_count").notNull().default(0),
    url: text("url").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    closedAt: text("closed_at"),
    fetchedAt: text("fetched_at").notNull(),
  },
  (t) => ({
    repoStateUpdatedIdx: index("github_issues_repo_state_updated_idx").on(
      t.repositoryId,
      t.state,
      t.updatedAt,
    ),
  }),
);
