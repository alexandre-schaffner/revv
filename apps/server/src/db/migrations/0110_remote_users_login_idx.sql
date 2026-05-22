-- Custom migration: add unique index on (provider, login) for login-based upsert fallback
CREATE UNIQUE INDEX IF NOT EXISTS "remote_users_provider_login_idx" ON "remote_users" ("provider", "login");
