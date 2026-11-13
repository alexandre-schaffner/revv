import { type SQL, sql } from "drizzle-orm";
import {
  integer,
  type SQLiteColumn,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Everyone who appears in the system — app users, PR authors, commenters,
 * reviewers, repo owners — by host and login: `alice` on github.com and
 * `alice` on a GitHub Enterprise host are different people.
 *
 * Avatar content is stored as a base64 data URL so the frontend never needs
 * to hit an external URL that might rotate or expire.
 */
export const remoteUsers = sqliteTable(
  "remote_users",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    /** Retired: users are identified by host + login. Kept for existing rows. */
    providerUserId: text("provider_user_id").notNull(),
    login: text("login").notNull(),
    displayName: text("display_name"),
    /** Base64 data URL of the fetched avatar (e.g. "data:image/png;base64,..."). */
    avatarContent: text("avatar_content"),
    lastFetchedAt: integer("last_fetched_at", { mode: "timestamp" }),
    /** The avatar URL last fetched from — tells a new image from a re-signed one. */
    lastAvatarUrl: text("last_avatar_url"),
    host: text("host").notNull().default("github.com"),
  },
  (t) => ({
    providerHostLoginIdx: uniqueIndex("remote_users_provider_host_login_idx").on(
      t.provider,
      t.host,
      t.login,
    ),
  }),
);

type SqlValue = SQLiteColumn | SQL | string;

/**
 * The cached avatar of `login` on the host of repository `repositoryId`. A
 * scalar subquery, so it never multiplies the outer query's rows.
 */
export function avatarOfRepoLogin(login: SqlValue, repositoryId: SqlValue): SQL<string | null> {
  return sql<
    string | null
  >`(SELECT ru.avatar_content FROM remote_users ru JOIN repositories r ON r.github_host = ru.host WHERE r.id = ${repositoryId} AND ru.provider = 'github' AND ru.login = ${login})`;
}

/** {@link avatarOfRepoLogin} for a login seen on pull request `pullRequestId`. */
export function avatarOfPrLogin(login: SqlValue, pullRequestId: SqlValue): SQL<string | null> {
  return sql<
    string | null
  >`(SELECT ru.avatar_content FROM remote_users ru JOIN repositories r ON r.github_host = ru.host JOIN pull_requests p ON p.repository_id = r.id WHERE p.id = ${pullRequestId} AND ru.provider = 'github' AND ru.login = ${login})`;
}

/** {@link avatarOfRepoLogin} for a login seen in comment thread `threadId`. */
export function avatarOfThreadLogin(login: SqlValue, threadId: SqlValue): SQL<string | null> {
  return sql<
    string | null
  >`(SELECT ru.avatar_content FROM remote_users ru JOIN repositories r ON r.github_host = ru.host JOIN pull_requests p ON p.repository_id = r.id JOIN review_sessions s ON s.pull_request_id = p.id JOIN comment_threads t ON t.review_session_id = s.id WHERE t.id = ${threadId} AND ru.provider = 'github' AND ru.login = ${login})`;
}

/** The cached avatar of `login` on an explicit host. */
export function avatarOfHostLogin(login: SqlValue, host: SqlValue): SQL<string | null> {
  return sql<
    string | null
  >`(SELECT ru.avatar_content FROM remote_users ru WHERE ru.host = ${host} AND ru.provider = 'github' AND ru.login = ${login})`;
}
