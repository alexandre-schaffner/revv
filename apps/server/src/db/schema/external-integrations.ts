import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { account, user } from "./auth";

/**
 * Durable credentials for tools that run outside Revv's own agent lifecycle.
 *
 * Only a SHA-256 digest is persisted. The plaintext token is written once to
 * the installed client configuration and can only be recovered by rotating it.
 */
export const externalIntegrations = sqliteTable(
  "external_integrations",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => account.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    scopes: text("scopes").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("uq_external_integrations_provider_account").on(table.provider, table.accountId),
    uniqueIndex("uq_external_integrations_token_hash").on(table.tokenHash),
    index("external_integrations_account_idx").on(table.accountId),
  ],
);
