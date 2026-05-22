import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Canonical user profiles for anyone who appears in the system — app users,
 * PR authors, commenters, reviewers. Provider-agnostic so it works for
 * GitHub, GitLab, BitBucket, etc.
 *
 * Avatar content is stored as a base64 data URL so the frontend never needs
 * to hit an external URL that might rotate or expire.
 */
export const remoteUsers = sqliteTable(
  "remote_users",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    /** Stable numeric/string ID from the provider (e.g. GitHub user.id). */
    providerUserId: text("provider_user_id").notNull(),
    /** Username on the provider (e.g. GitHub login). */
    login: text("login").notNull(),
    /** Display name / real name / screen name. */
    displayName: text("display_name"),
    /** Base64 data URL of the fetched avatar (e.g. "data:image/png;base64,..."). */
    avatarContent: text("avatar_content"),
    /** Epoch ms of when we last fetched the avatar from the provider. */
    lastFetchedAt: integer("last_fetched_at", { mode: "timestamp" }),
    /** The avatar URL we last fetched from — used to detect rotation. */
    lastAvatarUrl: text("last_avatar_url"),
  },
  (t) => ({
    providerLoginIdx: uniqueIndex("remote_users_provider_login_idx").on(t.provider, t.login),
  }),
);
