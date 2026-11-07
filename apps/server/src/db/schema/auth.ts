import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { remoteUsers } from "./remote-users";

// The tables better-auth created. Revv owns them now: `GitHubAccounts` writes users, accounts and
// sessions; `verification` is retired and never read.

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  githubLogin: text("github_login"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  // Null until the user finishes onboarding (the web app's OnboardingGate).
  // Survives reinstalls.
  onboardedAt: integer("onboarded_at", { mode: "timestamp" }),
  /** FK into remote_users — the authenticated user's canonical profile. */
  identityId: text("identity_id").references(() => remoteUsers.id),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  githubLogin: text("github_login"),
  avatarUrl: text("avatar_url"),
  // Set when a GitHub call returns 401 and the token could not be silently
  // refreshed (revoked, or no/expired refresh token). The orchestrator
  // broadcasts `auth:reauth-required` and the client gates the app behind a
  // re-sign-in modal. Cleared on any successful token write (device-flow
  // re-auth or a successful refresh). Durable so the state survives restart
  // and is reconcilable on SSE reconnect.
  reauthRequiredAt: integer("reauth_required_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  /**
   * The OAuth client the account's token was issued to. GitHub's refresh grant only accepts that
   * client. Null on rows from before the column: they resolve the bundled or env client ID.
   */
  clientId: text("client_id"),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});
